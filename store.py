"""Business logic on top of db.py. Routes in app.py stay thin and call these."""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime

import db
import koi_mirror
import sources

SPACE_LABEL = {"kitchen": "Kitchen", "pantry": "Pantry"}


class NotFound(Exception):
    pass


class BadRequest(Exception):
    pass


# ── helpers ───────────────────────────────────────────────────────────────────

def _clean(v, default=""):
    return v.strip() if isinstance(v, str) else (default if v is None else v)


def _level(v) -> int:
    try:
        return max(0, min(db.LEVEL_MAX, int(round(float(v)))))
    except (TypeError, ValueError):
        raise BadRequest("level must be a number from 0 to 10")


def _price(v):
    if v in (None, ""):
        return None
    try:
        return round(float(str(v).replace("$", "").strip()), 2)
    except ValueError:
        raise BadRequest("price must be a number")


def _update(c, table: str, id_: int, body: dict, allowed: dict) -> None:
    """UPDATE only the keys present in ``body``; ``allowed`` maps key -> coercer."""
    sets, args = [], []
    for k, coerce in allowed.items():
        if k in body:
            sets.append(f"{k} = ?")
            args.append(coerce(body[k]))
    if not sets:
        return
    cur = c.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE id = ?", (*args, id_))
    if cur.rowcount == 0:
        raise NotFound(f"{table} {id_} not found")


def location_paths(c) -> dict[int, str]:
    locs = {r["id"]: dict(r) for r in c.execute("SELECT * FROM locations")}
    out = {}
    for lid, loc in locs.items():
        parts, cur, seen = [], loc, set()
        while cur and cur["id"] not in seen:
            seen.add(cur["id"])
            parts.append(cur["name"])
            cur = locs.get(cur["parent_id"])
        parts.append(SPACE_LABEL[loc["space"]])
        out[lid] = " › ".join(reversed(parts))
    return out


# ── snapshot (everything the UI needs in one request) ─────────────────────────

def snapshot() -> dict:
    with db.tx() as c:
        locations = db.rows(c.execute("SELECT * FROM locations ORDER BY position, id"))
        ings = db.rows(c.execute(
            "SELECT id, name, description, category, brand, image, source, source_ref, notes, "
            "archived, created_at, updated_at FROM ingredients ORDER BY name COLLATE NOCASE"))
        stock = db.rows(c.execute("SELECT * FROM stock ORDER BY id"))
        last_bought = {r[0]: r[1] for r in c.execute(
            "SELECT ingredient_id, MAX(bought_at) FROM purchases GROUP BY ingredient_id")}
        lists = db.rows(c.execute(
            "SELECT * FROM grocery_lists ORDER BY pinned DESC, done_at IS NOT NULL, "
            "COALESCE(done_at, created_at) DESC"))
        items = db.rows(c.execute("SELECT * FROM grocery_items ORDER BY checked, position, id"))
        putaway = db.rows(c.execute("SELECT * FROM putaway ORDER BY created_at"))
        collections = db.rows(c.execute("SELECT * FROM recipe_collections ORDER BY position, name"))
        recipes = db.rows(c.execute(
            "SELECT id, title, image, rating, total_time, servings, ingredients, links, created_at "
            "FROM recipes ORDER BY title COLLATE NOCASE"))
        rlinks = db.rows(c.execute("SELECT * FROM recipe_collection_links"))

    by_ing = defaultdict(list)
    for s in stock:
        by_ing[s["ingredient_id"]].append(s)
    for i in ings:
        i["stock"] = by_ing.get(i["id"], [])
        i["last_bought"] = last_bought.get(i["id"])
    by_list = defaultdict(list)
    for it in items:
        by_list[it["list_id"]].append(it)
    for l in lists:
        l["items"] = by_list.get(l["id"], [])
    rcols = defaultdict(list)
    for l in rlinks:
        rcols[l["recipe_id"]].append(l["collection_id"])
    for r in recipes:
        r["collections"] = rcols.get(r["id"], [])
        r["line_ids"] = _recipe_line_ids(r, ings)
        del r["ingredients"], r["links"]
    return {
        "locations": locations, "ingredients": ings, "lists": lists, "putaway": putaway,
        "recipe_collections": collections, "recipes": recipes,
        "koillection": koi_mirror.status(),
    }


# ── locations ─────────────────────────────────────────────────────────────────

VALID_PARENT = {  # (space, kind) -> allowed parent kinds
    ("kitchen", "area"): (None,),
    ("kitchen", "shelf"): ("area",),
    ("pantry", "shelf"): (None,),
    ("pantry", "bin"): ("shelf",),
}


def create_location(body: dict) -> dict:
    space, kind = body.get("space"), body.get("kind")
    parent_id = body.get("parent_id") or None
    name = _clean(body.get("name"))
    if (space, kind) not in VALID_PARENT:
        raise BadRequest(f"can't create a {kind} in the {space}")
    if not name:
        raise BadRequest("name is required")
    with db.tx() as c:
        parent_kind = None
        if parent_id:
            p = db.row(c.execute("SELECT * FROM locations WHERE id = ?", (parent_id,)))
            if not p or p["space"] != space:
                raise BadRequest("parent not found in that space")
            parent_kind = p["kind"]
        if parent_kind not in VALID_PARENT[(space, kind)]:
            raise BadRequest(f"a {kind} can't go inside a {parent_kind or 'top level'}")
        pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM locations WHERE "
                        "space = ? AND parent_id IS ?", (space, parent_id)).fetchone()[0]
        cur = c.execute(
            "INSERT INTO locations (space, kind, parent_id, name, subtitle, image, icon, position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (space, kind, parent_id, name, _clean(body.get("subtitle")), body.get("image"),
             _clean(body.get("icon")), pos))
        return db.row(c.execute("SELECT * FROM locations WHERE id = ?", (cur.lastrowid,)))


def update_location(lid: int, body: dict) -> dict:
    with db.tx() as c:
        old = db.row(c.execute("SELECT image FROM locations WHERE id = ?", (lid,)))
        if not old:
            raise NotFound("location not found")
        _update(c, "locations", lid, body, {
            "name": lambda v: _clean(v) or "Untitled", "subtitle": _clean,
            "image": lambda v: v or None, "icon": _clean,
        })
        out = db.row(c.execute("SELECT * FROM locations WHERE id = ?", (lid,)))
    if "image" in body and old["image"] != out["image"]:
        sources.delete_image(old["image"])
    koi_mirror.push_for_location(lid)
    return out


def delete_location(lid: int) -> None:
    """Deleting a location keeps its ingredients: their stock rows become
    "unplaced" (location_id NULL) so nothing is silently lost."""
    koi_mirror.push_for_location(lid)
    with db.tx() as c:
        imgs = [r[0] for r in c.execute(
            "WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT l.id FROM locations l "
            "JOIN sub ON l.parent_id = sub.id) SELECT image FROM locations WHERE id IN (SELECT id FROM sub)",
            (lid,)) if r[0]]
        if c.execute("DELETE FROM locations WHERE id = ?", (lid,)).rowcount == 0:
            raise NotFound("location not found")
    for i in imgs:
        sources.delete_image(i)


def reorder_locations(ids: list[int]) -> None:
    with db.tx() as c:
        for pos, lid in enumerate(ids):
            c.execute("UPDATE locations SET position = ? WHERE id = ?", (pos, int(lid)))


# ── ingredients & stock ───────────────────────────────────────────────────────

ING_FIELDS = {
    "name": lambda v: _clean(v) or "Unnamed", "description": _clean, "category": _clean,
    "brand": _clean, "image": lambda v: v or None, "source": _clean, "source_ref": _clean,
    "notes": _clean, "archived": lambda v: 1 if v else 0,
}
def _space(v):
    if v not in ("kitchen", "pantry"):
        raise BadRequest("space must be kitchen or pantry")
    return v


STOCK_FIELDS = {
    "space": _space,
    "location_id": lambda v: int(v) if v else None, "level": _level, "container": _clean,
    "container_qty": _clean, "refill_qty": _clean, "price": _price,
}


def _insert_stock(c, ingredient_id: int, s: dict) -> int:
    vals = {k: f(s[k]) for k, f in STOCK_FIELDS.items() if k in s}
    vals.setdefault("level", db.LEVEL_MAX)
    if "space" not in vals:
        raise BadRequest("stock needs a space")
    if vals.get("location_id"):
        loc = db.row(c.execute("SELECT space FROM locations WHERE id = ?", (vals["location_id"],)))
        if not loc or loc["space"] != vals["space"]:
            raise BadRequest("location is not in that space")
    vals.update(ingredient_id=ingredient_id, updated_at=db.now())
    cur = c.execute(f"INSERT INTO stock ({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                    tuple(vals.values()))
    return cur.lastrowid


def create_ingredient(body: dict) -> dict:
    name = _clean(body.get("name"))
    if not name:
        raise BadRequest("name is required")
    with db.tx() as c:
        vals = {k: f(body[k]) for k, f in ING_FIELDS.items() if k in body}
        vals["name"] = name
        vals["created_at"] = vals["updated_at"] = db.now()
        cur = c.execute(f"INSERT INTO ingredients ({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                        tuple(vals.values()))
        iid = cur.lastrowid
        for s in body.get("stock") or []:
            _insert_stock(c, iid, s)
    koi_mirror.push(iid)
    return get_ingredient(iid)


def get_ingredient(iid: int) -> dict:
    with db.tx() as c:
        ing = db.row(c.execute("SELECT * FROM ingredients WHERE id = ?", (iid,)))
        if not ing:
            raise NotFound("ingredient not found")
        ing["stock"] = db.rows(c.execute("SELECT * FROM stock WHERE ingredient_id = ? ORDER BY id", (iid,)))
    ing.pop("koi_state", None)
    return ing


def update_ingredient(iid: int, body: dict) -> dict:
    with db.tx() as c:
        old = db.row(c.execute("SELECT image FROM ingredients WHERE id = ?", (iid,)))
        if not old:
            raise NotFound("ingredient not found")
        _update(c, "ingredients", iid, body, ING_FIELDS)
        c.execute("UPDATE ingredients SET updated_at = ? WHERE id = ?", (db.now(), iid))
    if "image" in body and old["image"] != body["image"]:
        sources.delete_image(old["image"])
    koi_mirror.push(iid)
    return get_ingredient(iid)


def delete_ingredient(iid: int) -> None:
    with db.tx() as c:
        ing = db.row(c.execute("SELECT image, koi_item_id FROM ingredients WHERE id = ?", (iid,)))
        if not ing:
            raise NotFound("ingredient not found")
        c.execute("DELETE FROM ingredients WHERE id = ?", (iid,))
    sources.delete_image(ing["image"])
    koi_mirror.remove(ing["koi_item_id"])


def add_stock(iid: int, body: dict) -> dict:
    with db.tx() as c:
        if not c.execute("SELECT 1 FROM ingredients WHERE id = ?", (iid,)).fetchone():
            raise NotFound("ingredient not found")
        _insert_stock(c, iid, body)
    koi_mirror.push(iid)
    return get_ingredient(iid)


def update_stock(sid: int, body: dict) -> dict:
    with db.tx() as c:
        s = db.row(c.execute("SELECT * FROM stock WHERE id = ?", (sid,)))
        if not s:
            raise NotFound("stock not found")
        if body.get("location_id"):
            space = body.get("space", s["space"])
            loc = db.row(c.execute("SELECT space FROM locations WHERE id = ?", (body["location_id"],)))
            if not loc or loc["space"] != space:
                raise BadRequest("location is not in that space")
        _update(c, "stock", sid, body, STOCK_FIELDS)
        c.execute("UPDATE stock SET updated_at = ? WHERE id = ?", (db.now(), sid))
    koi_mirror.push(s["ingredient_id"])
    return get_ingredient(s["ingredient_id"])


def delete_stock(sid: int) -> dict:
    with db.tx() as c:
        s = db.row(c.execute("SELECT ingredient_id FROM stock WHERE id = ?", (sid,)))
        if not s:
            raise NotFound("stock not found")
        c.execute("DELETE FROM stock WHERE id = ?", (sid,))
    koi_mirror.push(s["ingredient_id"])
    return get_ingredient(s["ingredient_id"])


def ingredient_history(iid: int) -> dict:
    """Purchase log (newest first) with the gap since the previous purchase,
    plus the recipes that use this ingredient."""
    with db.tx() as c:
        ing = db.row(c.execute("SELECT id, name, archived FROM ingredients WHERE id = ?", (iid,)))
        if not ing:
            raise NotFound("ingredient not found")
        buys = db.rows(c.execute("SELECT * FROM purchases WHERE ingredient_id = ? ORDER BY bought_at", (iid,)))
        all_ings = db.rows(c.execute("SELECT id, name, archived FROM ingredients"))
        recipes = db.rows(c.execute("SELECT id, title, image, rating, ingredients, links FROM recipes"))
    prev = None
    gaps = []
    for b in buys:
        d = datetime.fromisoformat(b["bought_at"])
        b["days_since_prev"] = (d - prev).days if prev else None
        if prev:
            gaps.append((d - prev).days)
        prev = d
    used_in = []
    for r in recipes:
        if iid in _recipe_line_ids(r, all_ings):
            used_in.append({"id": r["id"], "title": r["title"], "image": r["image"], "rating": r["rating"]})
    return {
        "purchases": list(reversed(buys)),
        "avg_days_between": round(sum(gaps) / len(gaps)) if gaps else None,
        "days_since_last": (datetime.now() - prev).days if prev else None,
        "recipes": used_in,
    }


def add_purchase(iid: int, body: dict) -> dict:
    with db.tx() as c:
        if not c.execute("SELECT 1 FROM ingredients WHERE id = ?", (iid,)).fetchone():
            raise NotFound("ingredient not found")
        when = _clean(body.get("bought_at")) or db.now()
        try:
            when = datetime.fromisoformat(when).isoformat(timespec="seconds")
        except ValueError:
            raise BadRequest("bought_at must be a date (YYYY-MM-DD)")
        c.execute("INSERT INTO purchases (ingredient_id, bought_at, qty, price, store) VALUES (?, ?, ?, ?, ?)",
                  (iid, when, _clean(body.get("qty")), _price(body.get("price")), _clean(body.get("store"))))
    return ingredient_history(iid)


def delete_purchase(pid: int) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM purchases WHERE id = ?", (pid,))
        c.execute("UPDATE grocery_items SET purchase_id = NULL WHERE purchase_id = ?", (pid,))


# ── duplicates ────────────────────────────────────────────────────────────────

def duplicates() -> dict:
    """Two kinds: one ingredient kept in several spots in the same space
    (could be consolidated), and separate ingredients whose names look like
    the same thing (could be merged)."""
    with db.tx() as c:
        ings = db.rows(c.execute("SELECT id, name, image, brand, archived FROM ingredients"))
        stock = db.rows(c.execute("SELECT * FROM stock"))
    by_id = {i["id"]: i for i in ings}
    groups = defaultdict(list)
    for s in stock:
        groups[(s["ingredient_id"], s["space"])].append(s)
    spread = [{"ingredient": by_id[iid], "space": space, "stock": rows}
              for (iid, space), rows in groups.items() if len(rows) > 1 and iid in by_id]

    by_norm = defaultdict(list)
    for i in ings:
        key = sources.normalized_name(i["name"])
        if key:
            by_norm[key].append(i)
    similar = [g for g in by_norm.values() if len(g) > 1]
    return {"spread": spread, "similar": similar}


def merge_ingredients(keep_id: int, other_id: int) -> dict:
    """Fold ``other`` into ``keep``: its stock, purchase history, grocery
    and put-away entries and recipe links all move over, then it's deleted."""
    if keep_id == other_id:
        raise BadRequest("pick two different ingredients")
    with db.tx() as c:
        keep = db.row(c.execute("SELECT * FROM ingredients WHERE id = ?", (keep_id,)))
        other = db.row(c.execute("SELECT * FROM ingredients WHERE id = ?", (other_id,)))
        if not keep or not other:
            raise NotFound("ingredient not found")
        for t in ("stock", "purchases", "grocery_items", "putaway"):
            c.execute(f"UPDATE {t} SET ingredient_id = ? WHERE ingredient_id = ?", (keep_id, other_id))
        for r in db.rows(c.execute("SELECT id, links FROM recipes")):
            links = db.jload(r["links"], {})
            if other_id in links.values():
                links = {k: (keep_id if v == other_id else v) for k, v in links.items()}
                c.execute("UPDATE recipes SET links = ? WHERE id = ?", (json.dumps(links), r["id"]))
        if not keep["image"] and other["image"]:
            c.execute("UPDATE ingredients SET image = ? WHERE id = ?", (other["image"], keep_id))
            other["image"] = None
        if not keep["description"] and other["description"]:
            c.execute("UPDATE ingredients SET description = ? WHERE id = ?", (other["description"], keep_id))
        c.execute("DELETE FROM ingredients WHERE id = ?", (other_id,))
    if other["image"]:
        sources.delete_image(other["image"])
    koi_mirror.remove(other["koi_item_id"])
    koi_mirror.push(keep_id)
    return get_ingredient(keep_id)


def consolidate_stock(keep_sid: int, other_sid: int) -> dict:
    """Pour one spot into another: levels add up (capped at full)."""
    with db.tx() as c:
        keep = db.row(c.execute("SELECT * FROM stock WHERE id = ?", (keep_sid,)))
        other = db.row(c.execute("SELECT * FROM stock WHERE id = ?", (other_sid,)))
        if not keep or not other or keep["ingredient_id"] != other["ingredient_id"]:
            raise BadRequest("those aren't two spots of the same ingredient")
        c.execute("UPDATE stock SET level = ?, updated_at = ? WHERE id = ?",
                  (min(db.LEVEL_MAX, keep["level"] + other["level"]), db.now(), keep_sid))
        c.execute("DELETE FROM stock WHERE id = ?", (other_sid,))
    koi_mirror.push(keep["ingredient_id"])
    return get_ingredient(keep["ingredient_id"])


# ── grocery lists ─────────────────────────────────────────────────────────────

def create_list(body: dict) -> dict:
    created = db.now()
    name = _clean(body.get("name")) or datetime.now().strftime("%a %b %-d, %Y")
    with db.tx() as c:
        cur = c.execute("INSERT INTO grocery_lists (name, store, pinned, created_at) VALUES (?, ?, ?, ?)",
                        (name, _clean(body.get("store")), 1 if body.get("pinned") else 0, created))
        return db.row(c.execute("SELECT * FROM grocery_lists WHERE id = ?", (cur.lastrowid,)))


def update_list(lid: int, body: dict) -> dict:
    with db.tx() as c:
        _update(c, "grocery_lists", lid, body, {
            "name": lambda v: _clean(v) or "Grocery list", "store": _clean,
            "pinned": lambda v: 1 if v else 0,
        })
        if "done" in body:
            c.execute("UPDATE grocery_lists SET done_at = ? WHERE id = ?",
                      (db.now() if body["done"] else None, lid))
        lst = db.row(c.execute("SELECT * FROM grocery_lists WHERE id = ?", (lid,)))
        if not lst:
            raise NotFound("list not found")
        # On finishing: which bought, tracked ingredients aren't queued for put-away yet?
        if body.get("done"):
            lst["putaway_candidates"] = db.rows(c.execute(
                "SELECT DISTINCT gi.ingredient_id, gi.qty, gi.text FROM grocery_items gi "
                "WHERE gi.list_id = ? AND gi.checked = 1 AND gi.ingredient_id IS NOT NULL "
                "AND gi.ingredient_id NOT IN (SELECT ingredient_id FROM putaway)", (lid,)))
        return lst


def delete_list(lid: int) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM grocery_lists WHERE id = ?", (lid,))


def reset_list(lid: int) -> None:
    """Uncheck everything (for pinned staple lists, reused each trip)."""
    with db.tx() as c:
        c.execute("UPDATE grocery_items SET checked = 0, checked_at = NULL, purchase_id = NULL WHERE list_id = ?",
                  (lid,))


def add_list_item(lid: int, body: dict) -> dict:
    text = _clean(body.get("text"))
    iid = body.get("ingredient_id") or None
    with db.tx() as c:
        lst = db.row(c.execute("SELECT * FROM grocery_lists WHERE id = ?", (lid,)))
        if not lst:
            raise NotFound("list not found")
        if iid:
            ing = db.row(c.execute("SELECT name FROM ingredients WHERE id = ?", (iid,)))
            if not ing:
                raise NotFound("ingredient not found")
            text = text or ing["name"]
            dup = db.row(c.execute("SELECT * FROM grocery_items WHERE list_id = ? AND ingredient_id = ? "
                                   "AND checked = 0", (lid, iid)))
            if dup:
                return {**dup, "already": True}
        if not text:
            raise BadRequest("item text is required")
        qty = _clean(body.get("qty"))
        if not qty and iid:
            r = c.execute("SELECT refill_qty FROM stock WHERE ingredient_id = ? AND refill_qty != '' "
                          "ORDER BY space = 'pantry' DESC LIMIT 1", (iid,)).fetchone()
            qty = r[0] if r else ""
        pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM grocery_items WHERE list_id = ?",
                        (lid,)).fetchone()[0]
        cur = c.execute(
            "INSERT INTO grocery_items (list_id, ingredient_id, recipe_id, text, qty, source, position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (lid, iid, body.get("recipe_id") or None, text, qty, _clean(body.get("source")) or "manual", pos))
        return db.row(c.execute("SELECT * FROM grocery_items WHERE id = ?", (cur.lastrowid,)))


def update_list_item(item_id: int, body: dict) -> dict:
    """Checking a tracked item logs a purchase (unchecking removes it again).
    The reply says whether to offer adding it to the put-away list."""
    with db.tx() as c:
        it = db.row(c.execute("SELECT gi.*, gl.store, gl.pinned FROM grocery_items gi "
                              "JOIN grocery_lists gl ON gl.id = gi.list_id WHERE gi.id = ?", (item_id,)))
        if not it:
            raise NotFound("item not found")
        _update(c, "grocery_items", item_id, body, {
            "text": lambda v: _clean(v) or it["text"], "qty": _clean,
            "ingredient_id": lambda v: int(v) if v else None, "position": int,
        })
        ask_putaway = False
        if "checked" in body and bool(body["checked"]) != bool(it["checked"]):
            iid = body.get("ingredient_id", it["ingredient_id"])
            if body["checked"]:
                pid = None
                if iid:
                    price = c.execute("SELECT price FROM stock WHERE ingredient_id = ? AND price IS NOT NULL "
                                      "LIMIT 1", (iid,)).fetchone()
                    pid = c.execute(
                        "INSERT INTO purchases (ingredient_id, bought_at, qty, price, store, list_id) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (iid, db.now(), _clean(body.get("qty", it["qty"])), price[0] if price else None,
                         it["store"], it["list_id"])).lastrowid
                    ask_putaway = not c.execute("SELECT 1 FROM putaway WHERE ingredient_id = ?",
                                                (iid,)).fetchone()
                c.execute("UPDATE grocery_items SET checked = 1, checked_at = ?, purchase_id = ? WHERE id = ?",
                          (db.now(), pid, item_id))
            else:
                if it["purchase_id"]:
                    c.execute("DELETE FROM purchases WHERE id = ?", (it["purchase_id"],))
                c.execute("UPDATE grocery_items SET checked = 0, checked_at = NULL, purchase_id = NULL "
                          "WHERE id = ?", (item_id,))
        out = db.row(c.execute("SELECT * FROM grocery_items WHERE id = ?", (item_id,)))
    out["ask_putaway"] = ask_putaway
    return out


def delete_list_item(item_id: int) -> None:
    with db.tx() as c:
        it = db.row(c.execute("SELECT purchase_id FROM grocery_items WHERE id = ?", (item_id,)))
        if it and it["purchase_id"]:
            c.execute("DELETE FROM purchases WHERE id = ?", (it["purchase_id"],))
        c.execute("DELETE FROM grocery_items WHERE id = ?", (item_id,))


# ── put-away ──────────────────────────────────────────────────────────────────

def add_putaway(entries: list[dict]) -> None:
    with db.tx() as c:
        for e in entries:
            iid = int(e["ingredient_id"])
            if c.execute("SELECT 1 FROM putaway WHERE ingredient_id = ?", (iid,)).fetchone():
                continue
            c.execute("INSERT INTO putaway (ingredient_id, qty, list_id, created_at) VALUES (?, ?, ?, ?)",
                      (iid, _clean(e.get("qty")), e.get("list_id"), db.now()))


def finish_putaway(pid: int, body: dict) -> None:
    """Put it away: the chosen stock spot (or every spot) goes back to full,
    or to ``level`` if given. Optionally places it somewhere new first."""
    with db.tx() as c:
        p = db.row(c.execute("SELECT * FROM putaway WHERE id = ?", (pid,)))
        if not p:
            raise NotFound("put-away entry not found")
        level = _level(body.get("level", db.LEVEL_MAX))
        iid = p["ingredient_id"]
        if body.get("new_location"):
            nl = body["new_location"]
            _insert_stock(c, iid, {"space": nl["space"], "location_id": nl.get("location_id"), "level": level,
                                   "container": nl.get("container", "")})
        else:
            sids = [int(body["stock_id"])] if body.get("stock_id") else \
                [r[0] for r in c.execute("SELECT id FROM stock WHERE ingredient_id = ?", (iid,))]
            for sid in sids:
                c.execute("UPDATE stock SET level = ?, updated_at = ? WHERE id = ? AND ingredient_id = ?",
                          (level, db.now(), sid, iid))
        c.execute("DELETE FROM putaway WHERE id = ?", (pid,))
    koi_mirror.push(iid)


def delete_putaway(pid: int) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM putaway WHERE id = ?", (pid,))


# ── recipes ───────────────────────────────────────────────────────────────────

def _recipe_line_ids(r: dict, ings: list[dict]) -> list[int | None]:
    """Ingredient id per recipe line: manual link if set (0 = "don't track"),
    otherwise the automatic name match."""
    lines = db.jload(r["ingredients"], []) if isinstance(r["ingredients"], str) else r["ingredients"]
    links = db.jload(r["links"], {}) if isinstance(r["links"], str) else r["links"]
    out = []
    for i, line in enumerate(lines):
        if str(i) in links:
            out.append(links[str(i)] or None)
        else:
            out.append(sources.match_line(line, ings))
    return out


RECIPE_FIELDS = {
    "title": lambda v: _clean(v) or "Untitled recipe", "source_url": _clean, "image": lambda v: v or None,
    "description": _clean, "servings": lambda v: _clean(str(v or "")), "prep_time": _clean,
    "cook_time": _clean, "total_time": _clean, "notes": _clean,
    "rating": lambda v: max(0, min(5, int(v or 0))),
    "ingredients": lambda v: json.dumps([str(x).strip() for x in v if str(x).strip()]),
    "directions": lambda v: json.dumps([str(x).strip() for x in v if str(x).strip()]),
    "links": lambda v: json.dumps({str(k): (int(x) if x else 0) for k, x in (v or {}).items()}),
}


def get_recipe(rid: int) -> dict:
    with db.tx() as c:
        r = db.row(c.execute("SELECT * FROM recipes WHERE id = ?", (rid,)))
        if not r:
            raise NotFound("recipe not found")
        ings = db.rows(c.execute("SELECT id, name, archived FROM ingredients"))
        r["collections"] = [x[0] for x in c.execute(
            "SELECT collection_id FROM recipe_collection_links WHERE recipe_id = ?", (rid,))]
    r["line_ids"] = _recipe_line_ids(r, ings)
    r["ingredients"] = db.jload(r["ingredients"], [])
    r["directions"] = db.jload(r["directions"], [])
    r["links"] = db.jload(r["links"], {})
    return r


def _set_collections(c, rid: int, ids) -> None:
    c.execute("DELETE FROM recipe_collection_links WHERE recipe_id = ?", (rid,))
    c.executemany("INSERT OR IGNORE INTO recipe_collection_links VALUES (?, ?)", [(rid, int(i)) for i in ids])


def create_recipe(body: dict) -> dict:
    if body.get("image_url") and not body.get("image"):
        try:
            body["image"] = sources.fetch_image(body["image_url"])
        except Exception as e:  # noqa: BLE001 - a recipe without a photo is fine
            print(f"[recipe] image fetch failed: {e}")
    vals = {k: f(body[k]) for k, f in RECIPE_FIELDS.items() if k in body}
    vals.setdefault("title", "Untitled recipe")
    vals["created_at"] = vals["updated_at"] = db.now()
    with db.tx() as c:
        rid = c.execute(f"INSERT INTO recipes ({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                        tuple(vals.values())).lastrowid
        _set_collections(c, rid, body.get("collections") or [])
    return get_recipe(rid)


def update_recipe(rid: int, body: dict) -> dict:
    with db.tx() as c:
        old = db.row(c.execute("SELECT image FROM recipes WHERE id = ?", (rid,)))
        if not old:
            raise NotFound("recipe not found")
        _update(c, "recipes", rid, body, RECIPE_FIELDS)
        c.execute("UPDATE recipes SET updated_at = ? WHERE id = ?", (db.now(), rid))
        if "collections" in body:
            _set_collections(c, rid, body["collections"])
    if "image" in body and old["image"] != body["image"]:
        sources.delete_image(old["image"])
    return get_recipe(rid)


def delete_recipe(rid: int) -> None:
    with db.tx() as c:
        r = db.row(c.execute("SELECT image FROM recipes WHERE id = ?", (rid,)))
        c.execute("DELETE FROM recipes WHERE id = ?", (rid,))
    if r:
        sources.delete_image(r["image"])


def create_collection(name: str) -> dict:
    name = _clean(name)
    if not name:
        raise BadRequest("name is required")
    with db.tx() as c:
        pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM recipe_collections").fetchone()[0]
        try:
            cid = c.execute("INSERT INTO recipe_collections (name, position) VALUES (?, ?)", (name, pos)).lastrowid
        except Exception:
            raise BadRequest("a collection with that name already exists")
        return db.row(c.execute("SELECT * FROM recipe_collections WHERE id = ?", (cid,)))


def rename_collection(cid: int, name: str) -> None:
    with db.tx() as c:
        _update(c, "recipe_collections", cid, {"name": name}, {"name": lambda v: _clean(v) or "Collection"})


def delete_collection(cid: int) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM recipe_collections WHERE id = ?", (cid,))
