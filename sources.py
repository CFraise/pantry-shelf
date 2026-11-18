"""Outside data: ingredient lookups, images and recipe import.

* TheMealDB's ingredient list (~600 generic ingredients with a description
  and a clean product-shot image) — the "TMDb for ingredients".
* Open Food Facts — packaged products with front-of-pack photos and barcodes
  (good coverage of Canadian and Kirkland/Costco products).
* recipe-scrapers — pulls title/ingredients/directions out of almost any
  recipe page (site-specific scrapers plus schema.org fallback).
"""
from __future__ import annotations

import concurrent.futures
import io
import json
import os
import re
import threading
import time
import uuid
from difflib import SequenceMatcher

import requests

from db import IMAGE_DIR

UA = "Mozilla/5.0 (compatible; PantryShelf/1.0; self-hosted recipe import)"
HTTP = requests.Session()
HTTP.headers["User-Agent"] = UA

MEALDB = "https://www.themealdb.com/api/json/v1/1"
OFF_SEARCH = "https://search.openfoodfacts.org/search"

_mealdb_cache: dict = {"at": 0.0, "items": []}
_mealdb_lock = threading.Lock()


# ── ingredient lookup ─────────────────────────────────────────────────────────

def _mealdb_ingredients() -> list[dict]:
    with _mealdb_lock:
        if _mealdb_cache["items"] and time.time() - _mealdb_cache["at"] < 7 * 86400:
            return _mealdb_cache["items"]
        r = HTTP.get(f"{MEALDB}/list.php", params={"i": "list"}, timeout=20)
        r.raise_for_status()
        items = []
        for m in r.json().get("meals") or []:
            name = (m.get("strIngredient") or "").strip()
            if not name:
                continue
            desc = (m.get("strDescription") or "").strip()
            items.append({
                "name": name,
                "description": _first_sentences(desc, 2),
                "category": (m.get("strType") or "") if m.get("strType") not in (None, "null") else "",
                "image": f"https://www.themealdb.com/images/ingredients/{requests.utils.quote(name)}.png",
                "source": "mealdb",
                "source_ref": name,
                "brand": "",
            })
        _mealdb_cache.update(at=time.time(), items=items)
        return items


def _first_sentences(text: str, n: int) -> str:
    parts = re.split(r"(?<=[.!?])\s+", text.replace("\r", " ").replace("\n", " "))
    out = " ".join(parts[:n]).strip()
    return out[:400]


def _score(query: str, name: str) -> float:
    q, n = query.lower().strip(), name.lower()
    if q == n:
        return 3.0
    if n.startswith(q):
        return 2.0 + len(q) / max(len(n), 1)
    if q in n:
        return 1.5 + len(q) / max(len(n), 1)
    words = q.split()
    if words and all(w in n for w in words):
        return 1.2
    return SequenceMatcher(None, q, n).ratio()


def search_generic(query: str, limit: int = 8) -> list[dict]:
    try:
        items = _mealdb_ingredients()
    except Exception as e:  # noqa: BLE001 - lookups are best-effort
        print(f"[lookup] mealdb failed: {e}")
        return []
    scored = sorted(((_score(query, i["name"]), i) for i in items), key=lambda t: -t[0])
    return [i for s, i in scored[:limit] if s >= 0.6]


def search_products(query: str, limit: int = 12) -> list[dict]:
    try:
        r = HTTP.get(OFF_SEARCH, params={
            "q": query,
            "page_size": limit * 2,
            "fields": "code,product_name,brands,image_front_small_url,image_front_url,"
                      "quantity,categories_tags,generic_name,countries_tags",
        }, timeout=20)
        r.raise_for_status()
        hits = r.json().get("hits") or []
    except Exception as e:  # noqa: BLE001
        print(f"[lookup] OFF failed: {e}")
        return []
    out = []
    for h in hits:
        name = (h.get("product_name") or "").strip()
        if not name:
            continue
        brands = h.get("brands") or []
        if isinstance(brands, str):
            brands = [brands]
        cats = [c.split(":", 1)[-1].replace("-", " ") for c in (h.get("categories_tags") or [])]
        countries = h.get("countries_tags") or []
        out.append({
            "name": name,
            "brand": ", ".join(dict.fromkeys(brands))[:80],
            "description": (h.get("generic_name") or "").strip()[:300],
            "category": cats[-1].title() if cats else "",
            "quantity": h.get("quantity") or "",
            "image": h.get("image_front_url") or h.get("image_front_small_url"),
            "thumb": h.get("image_front_small_url") or h.get("image_front_url"),
            "source": "off",
            "source_ref": h.get("code") or "",
            "_canada": any("canada" in c for c in countries),
        })
    # Products with a photo first, Canadian ones before the rest.
    out.sort(key=lambda p: (not p["image"], not p["_canada"]))
    for p in out:
        p.pop("_canada", None)
    return out[:limit]


# ── descriptions (Wikipedia) ──────────────────────────────────────────────────
# TheMealDB has no description for about half its ingredients, and Open Food
# Facts rarely has one, so descriptions come from the opening paragraph of the
# matching Wikipedia article. Wikimedia wants a descriptive User-Agent and
# rate-limits hard, so everything is batched into one or two requests and cached.

WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_UA = "PantryShelf/1.0 (self-hosted kitchen inventory app)"
_WIKI_QUALIFIERS = ("spice", "herb", "food", "condiment", "seasoning")
_WIKI_BASE = {"action": "query", "format": "json", "formatversion": 2, "redirects": 1,
              "prop": "extracts|pageprops|info", "inprop": "url", "ppprop": "disambiguation",
              "exintro": 1, "explaintext": 1}
_wiki_cache: dict[str, tuple[float, dict | None]] = {}


def _wiki_get(params: dict) -> dict:
    r = requests.get(WIKI_API, params={**_WIKI_BASE, **params},
                     headers={"User-Agent": WIKI_UA}, timeout=8)
    r.raise_for_status()
    return r.json().get("query") or {}


def _wiki_ok(p: dict) -> bool:
    return (not p.get("missing") and "disambiguation" not in (p.get("pageprops") or {})
            and bool((p.get("extract") or "").strip()))


def _wiki_clean(text: str, limit: int = 600) -> str:
    para = next((s for s in text.split("\n") if s.strip()), "")
    para = re.sub(r"\s*\(\s*[;,]?\s*\)", "", para)       # "Thyme () is" left by stripped IPA
    para = re.sub(r"\s+([,.;:])", r"\1", re.sub(r"\s{2,}", " ", para)).strip()
    if len(para) <= limit:
        return para
    out = ""
    for s in re.split(r"(?<=[.!?])\s+", para):
        if out and len(out) + len(s) + 1 > limit:
            break
        out = f"{out} {s}".strip()
    return out or para[:limit].rsplit(" ", 1)[0] + "…"


def describe(name: str) -> dict | None:
    """Opening paragraph of the best-matching Wikipedia article, or None.
    Tries the name itself, then food-qualified titles ("Mace (spice)"), then a
    cooking-biased search whose hit must actually mention every word of the name."""
    q = " ".join((name or "").split())
    if len(q) < 2:
        return None
    key = q.lower()
    hit = _wiki_cache.get(key)
    if hit and time.time() - hit[0] < (30 * 86400 if hit[1] else 3600):
        return hit[1]

    base = q[:1].upper() + q[1:].lower()
    cands = [base] + [f"{base} ({s})" for s in _WIKI_QUALIFIERS]
    found = None
    try:
        res = _wiki_get({"titles": "|".join(cands)})
        alias = {a["from"]: a["to"] for a in (res.get("normalized") or []) + (res.get("redirects") or [])}
        pages = {p["title"]: p for p in res.get("pages") or [] if _wiki_ok(p)}
        for c in cands:
            t = alias.get(c, c)
            t = alias.get(t, t)
            if t in pages:
                found = pages[t]
                break
        if not found:
            res = _wiki_get({"generator": "search", "gsrsearch": f"{q} cooking", "gsrlimit": 5})
            words = [w for w in re.findall(r"\w+", key) if len(w) > 2] or [key]
            for p in sorted(res.get("pages") or [], key=lambda p: p.get("index", 0)):
                hay = f"{p['title']} {(p.get('extract') or '')[:250]}".lower()
                if _wiki_ok(p) and all(w in hay for w in words):
                    found = p
                    break
    except Exception as e:  # noqa: BLE001 - best-effort; don't cache failures (often a 429)
        print(f"[describe] wikipedia failed for {q!r}: {e}")
        return None

    out = None
    if found:
        out = {"description": _wiki_clean(found["extract"]), "title": found["title"],
               "url": found.get("fullurl") or ""}
    _wiki_cache[key] = (time.time(), out)
    return out


def lookup(query: str) -> dict:
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        g = ex.submit(search_generic, query)
        p = ex.submit(search_products, query)
        return {"generic": g.result(), "products": p.result()}


# ── images ────────────────────────────────────────────────────────────────────

MAX_IMAGE_BYTES = 12 * 1024 * 1024
IMAGE_EDGE = 600


def save_image_bytes(content: bytes) -> str:
    """Normalise to a ≤600px image on disk; return the stored file name.
    PNGs with transparency stay PNG (ingredient cut-outs look best that way)."""
    from PIL import Image, ImageOps

    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError("Image is too large (12 MB max)")
    img = Image.open(io.BytesIO(content))
    img = ImageOps.exif_transpose(img)
    img.thumbnail((IMAGE_EDGE, IMAGE_EDGE))
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    name = uuid.uuid4().hex
    buf = io.BytesIO()
    if has_alpha:
        img.convert("RGBA").save(buf, "PNG", optimize=True)
        name += ".png"
    else:
        img.convert("RGB").save(buf, "JPEG", quality=85, optimize=True)
        name += ".jpg"
    with open(os.path.join(IMAGE_DIR, name), "wb") as f:
        f.write(buf.getvalue())
    return name


def fetch_image(url: str) -> str:
    if not re.match(r"^https?://", url or ""):
        raise ValueError("Image URL must start with http:// or https://")
    r = HTTP.get(url, timeout=25, stream=True)
    r.raise_for_status()
    data = r.raw.read(MAX_IMAGE_BYTES + 1, decode_content=True)
    return save_image_bytes(data)


def delete_image(name: str | None) -> None:
    if name and re.fullmatch(r"[0-9a-f]{32}\.(jpg|png)", name):
        try:
            os.remove(os.path.join(IMAGE_DIR, name))
        except FileNotFoundError:
            pass


# ── recipes ───────────────────────────────────────────────────────────────────

def _safe(fn, default=""):
    try:
        v = fn()
        return v if v not in (None, "") else default
    except Exception:  # noqa: BLE001 - every scraper field is optional
        return default


def _minutes(v) -> str:
    if v in (None, "", 0):
        return ""
    try:
        m = int(v)
    except (TypeError, ValueError):
        return str(v)
    return f"{m // 60}h {m % 60}m" if m >= 60 else f"{m} min"


def import_recipe_url(url: str) -> dict:
    from recipe_scrapers import scrape_html

    if not re.match(r"^https?://", url or ""):
        raise ValueError("Enter a full recipe URL (https://…)")
    r = HTTP.get(url, timeout=25, headers={"Accept-Language": "en-CA,en;q=0.9"})
    if r.status_code in (401, 403, 429):
        raise ValueError("That site doesn't allow automatic imports. Open the recipe in your "
                         "browser, copy it, and use “Paste recipe” instead.")
    r.raise_for_status()
    s = scrape_html(r.text, org_url=url, supported_only=False)
    ingredients = _safe(s.ingredients, [])
    directions = _safe(s.instructions_list, []) or [
        p for p in re.split(r"\n+", _safe(s.instructions, "")) if p.strip()
    ]
    if not ingredients and not directions:
        raise ValueError("Couldn't find a recipe on that page")
    return {
        "title": _safe(s.title, "Untitled recipe"),
        "source_url": url,
        "image_url": _safe(s.image, ""),
        "description": _safe(s.description, "")[:1000],
        "servings": str(_safe(s.yields, "")),
        "prep_time": _minutes(_safe(s.prep_time, "")),
        "cook_time": _minutes(_safe(s.cook_time, "")),
        "total_time": _minutes(_safe(s.total_time, "")),
        "ingredients": [i.strip() for i in ingredients if i and i.strip()],
        "directions": [d.strip() for d in directions if d and d.strip()],
    }


def browse_mealdb(query: str) -> list[dict]:
    r = HTTP.get(f"{MEALDB}/search.php", params={"s": query}, timeout=20)
    r.raise_for_status()
    return [_mealdb_meal(m) for m in (r.json().get("meals") or [])]


def mealdb_meal(meal_id: str) -> dict:
    r = HTTP.get(f"{MEALDB}/lookup.php", params={"i": meal_id}, timeout=20)
    r.raise_for_status()
    meals = r.json().get("meals") or []
    if not meals:
        raise ValueError("Recipe not found")
    return _mealdb_meal(meals[0])


def _mealdb_meal(m: dict) -> dict:
    ings = []
    for i in range(1, 21):
        name = (m.get(f"strIngredient{i}") or "").strip()
        measure = (m.get(f"strMeasure{i}") or "").strip()
        if name:
            ings.append(f"{measure} {name}".strip())
    steps = [s.strip() for s in re.split(r"\r?\n+", m.get("strInstructions") or "")
             if s.strip() and not re.fullmatch(r"(step\s*)?\d+\.?", s.strip(), re.I)]
    return {
        "mealdb_id": m.get("idMeal"),
        "title": m.get("strMeal") or "Untitled",
        "source_url": m.get("strSource") or f"https://www.themealdb.com/meal/{m.get('idMeal')}",
        "image_url": m.get("strMealThumb") or "",
        "description": " · ".join(x for x in (m.get("strCategory"), m.get("strArea")) if x),
        "category": m.get("strCategory") or "",
        "servings": "", "prep_time": "", "cook_time": "", "total_time": "",
        "ingredients": ings,
        "directions": steps,
    }


# ── matching recipe lines to ingredients ──────────────────────────────────────

_UNITS = r"(cups?|c\.|tbsps?|tablespoons?|tsps?|teaspoons?|g|grams?|kg|ml|l|litres?|liters?|oz|ounces?|lbs?|pounds?|" \
         r"pinch(es)?|dash(es)?|cloves?|cans?|tins?|packages?|pkgs?|sticks?|slices?|bunch(es)?|handfuls?|sprigs?|" \
         r"large|medium|small|whole|fresh|freshly|chopped|minced|diced|sliced|ground|to|taste|serve|serving|garnish|for|optional|of|and|or|a|an|the)"


# Qualifiers that don't change what an ingredient basically is ("Plain Flour"
# is still flour), unlike "Coconut Milk" vs milk.
_GENERIC = {"plain", "all", "purpose", "white", "granulated", "caster", "extra", "virgin", "kosher", "sea",
            "table", "unsalted", "salted", "fine", "coarse", "regular", "pure", "light", "everyday", "organic",
            "dried", "dry", "black", "large", "free", "range", "baking"}


def _norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"[^a-z\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _singular(w: str) -> str:
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("oes") and len(w) > 4:
        return w[:-2]
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        return w[:-1]
    return w


def _words(s: str) -> list[str]:
    return [_singular(w) for w in _norm(s).split() if not re.fullmatch(_UNITS, w)]


def match_line(line: str, ingredients: list[dict]) -> int | None:
    """Best ingredient id for a recipe line ("2 cups all-purpose flour"), or
    None. An ingredient matches when all its (singularised) name words appear
    in the line; the longest such name wins, so "brown sugar" beats "sugar"."""
    line_words = set(_words(line))
    if not line_words:
        return None
    best, best_len = None, 0
    for ing in ingredients:
        name_words = _words(ing["name"])
        if name_words and all(w in line_words for w in name_words):
            if len(name_words) > best_len:
                best, best_len = ing["id"], len(name_words)
    if best is not None:
        return best
    # Fallback: a terse line ("Flour") inside a more specific name ("Plain Flour").
    # Shortest such name wins, and only for short lines, to avoid wild guesses.
    if len(line_words) <= 2:
        cands = []
        for i in ingredients:
            nw = set(_words(i["name"]))
            if line_words <= nw and (nw - line_words) <= _GENERIC:
                cands.append((len(nw), i["id"]))
        if cands:
            return min(cands)[1]
    return None


def normalized_name(name: str) -> str:
    return " ".join(sorted(_words(name)))


def parse_pasted_recipe(text: str, title: str = "") -> dict:
    """Split copied recipe text into ingredients and directions. Looks for
    "Ingredients" / "Directions|Instructions|Method|Steps" headings; without
    them, short lines starting with a quantity count as ingredients."""
    lines = [l.strip(" \t•·-*▢☐") for l in text.replace("\r", "").split("\n")]
    lines = [l for l in lines if l]
    if not lines:
        raise ValueError("Paste some recipe text first")
    ing_h = re.compile(r"^ingredients?:?$", re.I)
    dir_h = re.compile(r"^(directions?|instructions?|method|steps|preparation):?$", re.I)
    if not title and not ing_h.match(lines[0]) and len(lines[0]) < 90:
        title = lines.pop(0)
    ings, steps, mode = [], [], None
    qty = re.compile(r"^([\d½¼¾⅓⅔⅛/.\s-]+|a |an |one |two |three |pinch|dash|salt|pepper)", re.I)
    for l in lines:
        if ing_h.match(l):
            mode = "i"; continue
        if dir_h.match(l):
            mode = "d"; continue
        if mode == "i":
            ings.append(l)
        elif mode == "d":
            steps.append(re.sub(r"^(step\s*)?\d+[.):]\s*", "", l, flags=re.I))
        elif qty.match(l) and len(l) < 80:
            ings.append(l)
        elif len(l) > 40:
            steps.append(re.sub(r"^(step\s*)?\d+[.):]\s*", "", l, flags=re.I))
    return {"title": title or "Untitled recipe", "source_url": "", "image_url": "", "description": "",
            "servings": "", "prep_time": "", "cook_time": "", "total_time": "",
            "ingredients": ings, "directions": [s for s in steps if s]}
