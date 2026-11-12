"""SQLite storage for Pantry Shelf.

One file (``$DATA_DIR/pantry.db``) holds everything: the kitchen/pantry
location tree, ingredients and where their stock sits, grocery lists, the
put-away list, purchase history and the recipe book. Koillection only gets a
read-only mirror of the ingredients (see koi_mirror.py).
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
DB_PATH = os.path.join(DATA_DIR, "pantry.db")
IMAGE_DIR = os.path.join(DATA_DIR, "images")

LEVEL_MAX = 10          # stock levels run 0 (empty) .. 10 (full)

DEFAULT_RECIPE_COLLECTIONS = [
    "Breakfast", "Lunch", "Dinner", "Dessert", "Salad", "Appetizer", "Snack", "Drinks",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY,
    space      TEXT NOT NULL CHECK (space IN ('kitchen', 'pantry')),
    kind       TEXT NOT NULL CHECK (kind IN ('area', 'shelf', 'bin')),
    parent_id  INTEGER REFERENCES locations(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    subtitle   TEXT NOT NULL DEFAULT '',
    image      TEXT,
    icon       TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingredients (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    category     TEXT NOT NULL DEFAULT '',
    brand        TEXT NOT NULL DEFAULT '',
    image        TEXT,
    source       TEXT NOT NULL DEFAULT 'manual',   -- manual / mealdb / off
    source_ref   TEXT NOT NULL DEFAULT '',         -- mealdb name / OFF barcode
    notes        TEXT NOT NULL DEFAULT '',
    archived     INTEGER NOT NULL DEFAULT 0,
    koi_item_id  TEXT,
    koi_state    TEXT,                             -- JSON: datum ids + last pushed values
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- One row per place an ingredient is kept. An ingredient can be in the
-- kitchen and the pantry at once, or (a duplicate) twice in the same space.
CREATE TABLE IF NOT EXISTS stock (
    id             INTEGER PRIMARY KEY,
    ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    space          TEXT NOT NULL CHECK (space IN ('kitchen', 'pantry')),
    location_id    INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    level          INTEGER NOT NULL DEFAULT 10,
    container      TEXT NOT NULL DEFAULT '',
    container_qty  TEXT NOT NULL DEFAULT '',
    refill_qty     TEXT NOT NULL DEFAULT '',
    price          REAL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grocery_lists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    store       TEXT NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    done_at     TEXT
);

CREATE TABLE IF NOT EXISTS grocery_items (
    id             INTEGER PRIMARY KEY,
    list_id        INTEGER NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
    ingredient_id  INTEGER REFERENCES ingredients(id) ON DELETE SET NULL,
    recipe_id      INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    text           TEXT NOT NULL,
    qty            TEXT NOT NULL DEFAULT '',
    source         TEXT NOT NULL DEFAULT 'manual',   -- manual / pantry / kitchen / recipe / staple
    checked        INTEGER NOT NULL DEFAULT 0,
    checked_at     TEXT,
    purchase_id    INTEGER,
    position       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS putaway (
    id             INTEGER PRIMARY KEY,
    ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qty            TEXT NOT NULL DEFAULT '',
    list_id        INTEGER,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
    id             INTEGER PRIMARY KEY,
    ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    bought_at      TEXT NOT NULL,
    qty            TEXT NOT NULL DEFAULT '',
    price          REAL,
    store          TEXT NOT NULL DEFAULT '',
    list_id        INTEGER
);

CREATE TABLE IF NOT EXISTS recipes (
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL,
    source_url   TEXT NOT NULL DEFAULT '',
    image        TEXT,
    description  TEXT NOT NULL DEFAULT '',
    servings     TEXT NOT NULL DEFAULT '',
    prep_time    TEXT NOT NULL DEFAULT '',
    cook_time    TEXT NOT NULL DEFAULT '',
    total_time   TEXT NOT NULL DEFAULT '',
    ingredients  TEXT NOT NULL DEFAULT '[]',   -- JSON list of ingredient lines
    directions   TEXT NOT NULL DEFAULT '[]',   -- JSON list of steps
    links        TEXT NOT NULL DEFAULT '{}',   -- JSON {line index: ingredient id, or 0 = "not tracked"}
    notes        TEXT NOT NULL DEFAULT '',
    rating       INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipe_collections (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recipe_collection_links (
    recipe_id      INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    collection_id  INTEGER NOT NULL REFERENCES recipe_collections(id) ON DELETE CASCADE,
    PRIMARY KEY (recipe_id, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_ingredient ON stock(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_stock_location ON stock(location_id);
CREATE INDEX IF NOT EXISTS idx_items_list ON grocery_items(list_id);
CREATE INDEX IF NOT EXISTS idx_purchases_ing ON purchases(ingredient_id, bought_at);
"""

_lock = threading.RLock()


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def tx():
    """A connection inside one transaction; writes are serialised by a lock
    so the gunicorn threads never fight over SQLite's write lock."""
    with _lock:
        conn = connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init() -> None:
    os.makedirs(IMAGE_DIR, exist_ok=True)
    with tx() as c:
        c.executescript(SCHEMA)
        if not c.execute("SELECT 1 FROM recipe_collections LIMIT 1").fetchone():
            c.executemany(
                "INSERT INTO recipe_collections (name, position) VALUES (?, ?)",
                [(n, i) for i, n in enumerate(DEFAULT_RECIPE_COLLECTIONS)],
            )


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def row(cur) -> dict | None:
    r = cur.fetchone()
    return dict(r) if r else None


def jload(text: str | None, default):
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default
