"""One-way mirror of ingredients into a Koillection "Pantry" collection.

Pantry Shelf's SQLite database is the source of truth; Koillection just gets
a browsable copy (name, picture, category, where it lives, how full it is).
Changes are queued and pushed by a background thread, so a slow or offline
Koillection never slows the app down. Edits made in Koillection are not read
back, and are overwritten the next time that ingredient changes here.

Enable with KOI_MIRROR=1. Credentials come from KOILLECTION_URL/USERNAME/
PASSWORD or koicli's ~/.config/koicli/config.toml (same as movie-shelf).
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time

import db
from koillection_client import KoillectionClient, KoillectionError

COLLECTION_TITLE = os.environ.get("KOI_COLLECTION", "Pantry")
FIELDS = ["Category", "Brand", "Kitchen Location", "Kitchen Level",
          "Pantry Location", "Pantry Level", "Container", "Status", "Description"]

_q: "queue.Queue[tuple[str, int | str]]" = queue.Queue()
_status = {"enabled": False, "error": None, "last_sync": None, "pending": 0}


def enabled() -> bool:
    return os.environ.get("KOI_MIRROR", "0").lower() in ("1", "true", "yes")


def load_config() -> dict | None:
    url = os.environ.get("KOILLECTION_URL")
    user = os.environ.get("KOILLECTION_USERNAME")
    pw = os.environ.get("KOILLECTION_PASSWORD")
    if url and user and pw:
        return {"url": url, "username": user, "password": pw}
    for path in [os.path.expanduser("~/.config/koicli/config.toml"), "/config/config.toml"]:
        if os.path.exists(path) and sys.version_info >= (3, 11):
            import tomllib
            with open(path, "rb") as f:
                cfg = tomllib.load(f)
            if cfg.get("koillection_url"):
                return {"url": cfg["koillection_url"], "username": cfg.get("koillection_username", ""),
                        "password": cfg.get("koillection_password", "")}
    return None


def status() -> dict:
    return {**_status, "pending": _q.qsize(), "collection": COLLECTION_TITLE}


def push(ingredient_id: int) -> None:
    if _status["enabled"]:
        _q.put(("push", ingredient_id))


def push_for_location(location_id: int) -> None:
    """A renamed/moved location changes the path text of everything in it."""
    if not _status["enabled"]:
        return
    with db.tx() as c:
        ids = {r[0] for r in c.execute(
            "WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL "
            "SELECT l.id FROM locations l JOIN sub ON l.parent_id = sub.id) "
            "SELECT DISTINCT s.ingredient_id FROM stock s WHERE s.location_id IN (SELECT id FROM sub)",
            (location_id,))}
    for i in ids:
        _q.put(("push", i))


def remove(koi_item_id: str | None) -> None:
    if _status["enabled"] and koi_item_id:
        _q.put(("delete", koi_item_id))


def resync_all() -> int:
    with db.tx() as c:
        ids = [r[0] for r in c.execute("SELECT id FROM ingredients")]
    for i in ids:
        _q.put(("push", i))
    return len(ids)


def start() -> None:
    if not enabled():
        return
    cfg = load_config()
    if not cfg:
        _status["error"] = "KOI_MIRROR is on but no Koillection credentials were found"
        print(f"[koi] {_status['error']}")
        return
    _status["enabled"] = True
    threading.Thread(target=_worker, args=(cfg,), daemon=True, name="koi-mirror").start()


# ── worker ────────────────────────────────────────────────────────────────────

class _Mirror:
    def __init__(self, cfg: dict):
        self.client = KoillectionClient(cfg["url"], cfg["username"], cfg["password"])
        self.collection_iri: str | None = None

    def collection(self) -> str:
        if self.collection_iri is None:
            col = self.client.get_collection_by_title(COLLECTION_TITLE)
            if col is None:
                col = self.client._post_json("/api/collections", {"title": COLLECTION_TITLE})
                print(f"[koi] created collection {COLLECTION_TITLE!r}")
            self.collection_iri = col["@id"]
        return self.collection_iri

    def values_for(self, c, ing: dict) -> dict:
        from store import location_paths  # late import: avoids a cycle
        paths = location_paths(c)
        stock = db.rows(c.execute("SELECT * FROM stock WHERE ingredient_id = ? ORDER BY id", (ing["id"],)))

        def side(space):
            rows = [s for s in stock if s["space"] == space]
            locs = "; ".join(paths.get(s["location_id"], "Unplaced") for s in rows)
            lvls = "; ".join(f"{s['level'] * 10}%" for s in rows)
            return locs, lvls

        k_loc, k_lvl = side("kitchen")
        p_loc, p_lvl = side("pantry")
        containers = "; ".join(dict.fromkeys(
            " ".join(x for x in (s["container_qty"], s["container"]) if x) for s in stock if s["container"]))
        low = any(s["level"] <= 2 for s in stock)
        return {
            "Category": ing["category"], "Brand": ing["brand"],
            "Kitchen Location": k_loc, "Kitchen Level": k_lvl,
            "Pantry Location": p_loc, "Pantry Level": p_lvl,
            "Container": containers,
            "Status": "Archived" if ing["archived"] else ("Needs restock" if low else "Stocked"),
            "Description": ing["description"],
        }

    def push(self, ingredient_id: int) -> None:
        with db.tx() as c:
            ing = db.row(c.execute("SELECT * FROM ingredients WHERE id = ?", (ingredient_id,)))
            if not ing:
                return
            values = self.values_for(c, ing)
        state = db.jload(ing["koi_state"], {})
        item_id = ing["koi_item_id"]
        cl = self.client

        if item_id:
            try:
                cl._get_json(f"/api/items/{item_id}")
            except KoillectionError as e:
                if "404" in str(e):          # deleted in Koillection: recreate it
                    item_id, state = None, {}
                else:
                    raise
        if not item_id:
            item = cl.create_item(ing["name"], self.collection())
            item_id = item["id"]
            state = {"data": {}, "name": ing["name"]}
            for pos, label in enumerate(FIELDS):
                d = cl.create_datum(item_iri=item["@id"], datum_type="text", label=label,
                                    value=values[label] or None, position=pos)
                state["data"][label] = {"id": d["id"], "value": values[label]}
        else:
            if state.get("name") != ing["name"]:
                cl._patch_json(f"/api/items/{item_id}", {"name": ing["name"]})
                state["name"] = ing["name"]
            for pos, label in enumerate(FIELDS):
                cur = state.setdefault("data", {}).get(label)
                if cur is None:
                    d = cl.create_datum(item_iri=f"/api/items/{item_id}", datum_type="text",
                                        label=label, value=values[label] or None, position=pos)
                    state["data"][label] = {"id": d["id"], "value": values[label]}
                elif cur["value"] != values[label]:
                    cl.update_datum(cur["id"], value=values[label] or None)
                    cur["value"] = values[label]

        if ing["image"] and state.get("image") != ing["image"]:
            path = os.path.join(db.IMAGE_DIR, ing["image"])
            if os.path.exists(path):
                with open(path, "rb") as f:
                    ctype = "image/png" if ing["image"].endswith(".png") else "image/jpeg"
                    cl.upload_item_image(item_id, ing["image"], f.read(), ctype)
                state["image"] = ing["image"]

        with db.tx() as c:
            c.execute("UPDATE ingredients SET koi_item_id = ?, koi_state = ? WHERE id = ?",
                      (item_id, json.dumps(state), ingredient_id))

    def delete(self, item_id: str) -> None:
        try:
            self.client._request("DELETE", f"/api/items/{item_id}")
        except KoillectionError as e:
            if "404" not in str(e):
                raise


def _worker(cfg: dict) -> None:
    m = _Mirror(cfg)
    while True:
        op, arg = _q.get()
        # Collapse bursts (a slider drag queues many pushes for one item).
        time.sleep(0.5)
        pending = [(op, arg)]
        while True:
            try:
                pending.append(_q.get_nowait())
            except queue.Empty:
                break
        for op, arg in dict.fromkeys(pending):
            for attempt in range(3):
                try:
                    if op == "push":
                        m.push(int(arg))
                    else:
                        m.delete(str(arg))
                    _status.update(error=None, last_sync=db.now())
                    break
                except Exception as e:  # noqa: BLE001 - keep the worker alive
                    _status["error"] = f"{type(e).__name__}: {e}"[:300]
                    print(f"[koi] {op} {arg} failed (try {attempt + 1}): {e}")
                    time.sleep(5 * (attempt + 1))
