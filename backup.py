"""Weekly automatic backups of the Pantry Shelf database (and its pictures).

Each backup is a folder ``$DATA_DIR/backups/YYYY-MM-DD_HHMMSS/`` holding:

* ``pantry.db``: a consistent copy made with SQLite's online backup API,
  safe to take while the app is running;
* ``images/``: hard links to the picture files. Pictures are never edited
  in place (a new one gets a new name), so linking is a full copy that
  takes no extra disk space, and a picture the app later deletes survives in
  any backup that still references it.

A background thread checks hourly and makes a backup when the newest one is
older than BACKUP_INTERVAL_DAYS (default 7), keeping the newest BACKUP_KEEP
(default 3). See the README for restoring one.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timedelta

import db

BACKUP_DIR = os.path.join(db.DATA_DIR, "backups")
KEEP = int(os.environ.get("BACKUP_KEEP", 3))
INTERVAL = timedelta(days=float(os.environ.get("BACKUP_INTERVAL_DAYS", 7)))
STAMP = "%Y-%m-%d_%H%M%S"

_lock = threading.Lock()


def list_backups() -> list[dict]:
    """Newest first."""
    out = []
    if not os.path.isdir(BACKUP_DIR):
        return out
    for name in os.listdir(BACKUP_DIR):
        try:
            when = datetime.strptime(name, STAMP)
        except ValueError:
            continue                      # not ours (e.g. a half-written .tmp folder)
        path = os.path.join(BACKUP_DIR, name)
        if os.path.exists(os.path.join(path, "pantry.db")):
            out.append({"name": name, "path": path, "created": when.isoformat(),
                        "size": os.path.getsize(os.path.join(path, "pantry.db"))})
    return sorted(out, key=lambda b: b["name"], reverse=True)


def make_backup() -> dict:
    with _lock:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        name = datetime.now().strftime(STAMP)
        final = os.path.join(BACKUP_DIR, name)
        tmp = final + ".tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "images"))

        src = sqlite3.connect(db.DB_PATH)
        dst = sqlite3.connect(os.path.join(tmp, "pantry.db"))
        try:
            src.backup(dst)
            ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
            if ok != "ok":
                raise RuntimeError(f"backup failed integrity check: {ok}")
        finally:
            dst.close()
            src.close()

        for f in os.listdir(db.IMAGE_DIR):
            s = os.path.join(db.IMAGE_DIR, f)
            d = os.path.join(tmp, "images", f)
            try:
                os.link(s, d)
            except OSError:               # different filesystem: fall back to copying
                shutil.copy2(s, d)

        os.rename(tmp, final)             # only complete backups get a real name
        for old in list_backups()[KEEP:]:
            shutil.rmtree(old["path"], ignore_errors=True)
        print(f"[backup] saved {name}; keeping {min(KEEP, len(list_backups()))}")
        return next(b for b in list_backups() if b["name"] == name)


def due() -> bool:
    b = list_backups()
    return not b or datetime.now() - datetime.fromisoformat(b[0]["created"]) >= INTERVAL


def _loop() -> None:
    time.sleep(60)                        # let the app finish starting
    while True:
        try:
            if due():
                make_backup()
        except Exception as e:  # noqa: BLE001 - never let the thread die
            print(f"[backup] failed: {e}")
        time.sleep(3600)


def start() -> None:
    threading.Thread(target=_loop, daemon=True, name="backup").start()
