#!/usr/bin/env bash
# Roll Pantry Shelf back to one of its automatic backups.
#
#   ./restore.sh                      list the backups
#   ./restore.sh 2026-11-11_193000    restore that one
#
# Stops the container, saves the current database as data/pre-restore-<time>/
# (so a restore can itself be undone), puts the backup's database and pictures
# in place, and starts the container again.
set -euo pipefail
cd "$(dirname "$0")"
DATA=./data
BACKUPS=$DATA/backups

if [ $# -eq 0 ]; then
  echo "Backups (newest first):"
  ls -1r "$BACKUPS" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' || echo "  (none yet)"
  echo
  echo "Restore one with: $0 <name>"
  exit 0
fi

SRC=$BACKUPS/$1
[ -f "$SRC/pantry.db" ] || { echo "No backup called '$1' in $BACKUPS" >&2; exit 1; }

echo "Restoring $1 (current data is kept in $DATA/pre-restore-*)"
docker compose stop pantry-shelf

SAFE=$DATA/pre-restore-$(date +%Y-%m-%d_%H%M%S)
mkdir -p "$SAFE"
for f in pantry.db pantry.db-wal pantry.db-shm; do
  [ -e "$DATA/$f" ] && sudo mv "$DATA/$f" "$SAFE/"
done
[ -d "$DATA/images" ] && sudo mv "$DATA/images" "$SAFE/images"

sudo cp "$SRC/pantry.db" "$DATA/pantry.db"
sudo cp -al "$SRC/images" "$DATA/images"   # hard links: instant, no extra space

docker compose start pantry-shelf
echo "Done. Pantry Shelf is back to $1."
echo "If that was a mistake, restore the previous state from $SAFE the same way (see README)."
