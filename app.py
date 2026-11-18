"""Pantry Shelf — Flask routes. Logic lives in store.py / sources.py."""
from __future__ import annotations

import os
import re

from flask import Flask, Response, jsonify, request, send_from_directory

import backup
import db
import koi_mirror
import sources
import store

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

db.init()
koi_mirror.start()
backup.start()


@app.errorhandler(store.NotFound)
def _nf(e):
    return jsonify({"error": str(e)}), 404


@app.errorhandler(store.BadRequest)
@app.errorhandler(ValueError)
def _bad(e):
    return jsonify({"error": str(e)}), 400


def body() -> dict:
    return request.get_json(silent=True) or {}


# ── pages & files ─────────────────────────────────────────────────────────────

@app.get("/")
def index():
    resp = send_from_directory("static", "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.after_request
def _no_stale_static(resp):
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/img/<name>")
def image(name):
    if not re.fullmatch(r"[0-9a-f]{32}\.(jpg|png)", name):
        return Response(status=404)
    resp = send_from_directory(db.IMAGE_DIR, name)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.post("/api/images/upload")
def upload_image():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "no file"}), 400
    try:
        return jsonify({"image": sources.save_image_bytes(f.read())})
    except Exception as e:  # noqa: BLE001 - PIL raises many types for bad files
        return jsonify({"error": f"Couldn't read that image ({e})"}), 400


@app.post("/api/images/fetch")
def fetch_image():
    try:
        return jsonify({"image": sources.fetch_image(body().get("url", ""))})
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"Couldn't download that image ({e})"}), 400


# ── everything at once ────────────────────────────────────────────────────────

@app.get("/api/snapshot")
def snapshot():
    snap = store.snapshot()
    b = backup.list_backups()
    snap["last_backup"] = b[0]["created"] if b else None
    return jsonify(snap)


@app.get("/api/backups")
def backups_list():
    return jsonify(backup.list_backups())


@app.post("/api/backups")
def backups_make():
    return jsonify(backup.make_backup())


@app.get("/api/lookup")
def lookup():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"generic": [], "products": []})
    return jsonify(sources.lookup(q))


@app.get("/api/describe")
def describe():
    return jsonify(sources.describe(request.args.get("q") or "") or {})


# ── locations ─────────────────────────────────────────────────────────────────

@app.post("/api/locations")
def loc_create():
    return jsonify(store.create_location(body()))


@app.patch("/api/locations/<int:lid>")
def loc_update(lid):
    return jsonify(store.update_location(lid, body()))


@app.delete("/api/locations/<int:lid>")
def loc_delete(lid):
    store.delete_location(lid)
    return jsonify({"ok": True})


@app.post("/api/locations/reorder")
def loc_reorder():
    store.reorder_locations(body().get("ids") or [])
    return jsonify({"ok": True})


# ── ingredients ───────────────────────────────────────────────────────────────

@app.post("/api/ingredients")
def ing_create():
    return jsonify(store.create_ingredient(body()))


@app.patch("/api/ingredients/<int:iid>")
def ing_update(iid):
    return jsonify(store.update_ingredient(iid, body()))


@app.delete("/api/ingredients/<int:iid>")
def ing_delete(iid):
    store.delete_ingredient(iid)
    return jsonify({"ok": True})


@app.get("/api/ingredients/<int:iid>/history")
def ing_history(iid):
    return jsonify(store.ingredient_history(iid))


@app.post("/api/ingredients/<int:iid>/purchases")
def ing_purchase(iid):
    return jsonify(store.add_purchase(iid, body()))


@app.delete("/api/purchases/<int:pid>")
def purchase_delete(pid):
    store.delete_purchase(pid)
    return jsonify({"ok": True})


@app.post("/api/ingredients/<int:iid>/stock")
def stock_add(iid):
    return jsonify(store.add_stock(iid, body()))


@app.patch("/api/stock/<int:sid>")
def stock_update(sid):
    return jsonify(store.update_stock(sid, body()))


@app.delete("/api/stock/<int:sid>")
def stock_delete(sid):
    return jsonify(store.delete_stock(sid))


@app.get("/api/duplicates")
def dupes():
    return jsonify(store.duplicates())


@app.post("/api/ingredients/merge")
def ing_merge():
    b = body()
    return jsonify(store.merge_ingredients(int(b["keep_id"]), int(b["other_id"])))


@app.post("/api/stock/consolidate")
def stock_consolidate():
    b = body()
    return jsonify(store.consolidate_stock(int(b["keep_id"]), int(b["other_id"])))


# ── grocery lists ─────────────────────────────────────────────────────────────

@app.post("/api/lists")
def list_create():
    return jsonify(store.create_list(body()))


@app.patch("/api/lists/<int:lid>")
def list_update(lid):
    return jsonify(store.update_list(lid, body()))


@app.delete("/api/lists/<int:lid>")
def list_delete(lid):
    store.delete_list(lid)
    return jsonify({"ok": True})


@app.post("/api/lists/<int:lid>/reset")
def list_reset(lid):
    store.reset_list(lid)
    return jsonify({"ok": True})


@app.post("/api/lists/<int:lid>/items")
def item_add(lid):
    return jsonify(store.add_list_item(lid, body()))


@app.patch("/api/items/<int:item_id>")
def item_update(item_id):
    return jsonify(store.update_list_item(item_id, body()))


@app.delete("/api/items/<int:item_id>")
def item_delete(item_id):
    store.delete_list_item(item_id)
    return jsonify({"ok": True})


# ── put-away ──────────────────────────────────────────────────────────────────

@app.post("/api/putaway")
def putaway_add():
    store.add_putaway(body().get("entries") or [])
    return jsonify({"ok": True})


@app.post("/api/putaway/<int:pid>/done")
def putaway_done(pid):
    store.finish_putaway(pid, body())
    return jsonify({"ok": True})


@app.delete("/api/putaway/<int:pid>")
def putaway_delete(pid):
    store.delete_putaway(pid)
    return jsonify({"ok": True})


# ── recipes ───────────────────────────────────────────────────────────────────

@app.get("/api/recipes/<int:rid>")
def recipe_get(rid):
    return jsonify(store.get_recipe(rid))


@app.post("/api/recipes")
def recipe_create():
    return jsonify(store.create_recipe(body()))


@app.patch("/api/recipes/<int:rid>")
def recipe_update(rid):
    return jsonify(store.update_recipe(rid, body()))


@app.delete("/api/recipes/<int:rid>")
def recipe_delete(rid):
    store.delete_recipe(rid)
    return jsonify({"ok": True})


@app.post("/api/recipes/parse-url")
def recipe_parse():
    """Scrape a URL into an editable draft (nothing is saved yet)."""
    try:
        return jsonify(sources.import_recipe_url(body().get("url", "").strip()))
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"Couldn't read that page ({type(e).__name__}: {e})"[:300]}), 400


@app.post("/api/recipes/parse-text")
def recipe_parse_text():
    b = body()
    return jsonify(sources.parse_pasted_recipe(b.get("text", ""), b.get("title", "")))


@app.get("/api/recipes/browse")
def recipe_browse():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify([])
    try:
        return jsonify(sources.browse_mealdb(q))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


@app.post("/api/recipe-collections")
def rcol_create():
    return jsonify(store.create_collection(body().get("name", "")))


@app.patch("/api/recipe-collections/<int:cid>")
def rcol_rename(cid):
    store.rename_collection(cid, body().get("name", ""))
    return jsonify({"ok": True})


@app.delete("/api/recipe-collections/<int:cid>")
def rcol_delete(cid):
    store.delete_collection(cid)
    return jsonify({"ok": True})


# ── koillection mirror ────────────────────────────────────────────────────────

@app.post("/api/koillection/resync")
def koi_resync():
    if not koi_mirror.status()["enabled"]:
        return jsonify({"error": "Koillection mirror is off (set KOI_MIRROR=1)"}), 400
    return jsonify({"queued": koi_mirror.resync_all()})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5010)), debug=True)
