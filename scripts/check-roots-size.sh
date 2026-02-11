#!/usr/bin/env bash
# Usage: scripts/check-roots-size.sh [db_path]
set -euo pipefail

DB="${1:-${MEGAMEMORY_DB_PATH:-.megamemory/knowledge.db}}"
command -v sqlite3 >/dev/null || { echo "sqlite3 not found in PATH"; exit 1; }
[[ -f "$DB" ]] || { echo "Database not found: $DB"; exit 1; }

ROOT_JSON="json_object('name',r.name,'summary',r.summary,'children',coalesce((select json_group_array(json_object('id',c.id,'name',c.name,'kind',c.kind,'summary',c.summary)) from nodes c where c.parent_id=r.id and c.removed_at is null),'[]'))"

echo "DB: $DB"
COUNT="$(sqlite3 "$DB" "select count(*) from nodes where parent_id is null and removed_at is null;")"
echo "Root concepts: $COUNT"
echo "Per-root JSON bytes:"
sqlite3 -separator $'\t' "$DB" "select r.name, length($ROOT_JSON) from nodes r where r.parent_id is null and r.removed_at is null order by r.name;" |
while IFS=$'\t' read -r name bytes; do printf "  - %s: %s\n" "$name" "$bytes"; done

TOTAL="$(sqlite3 "$DB" "select length(json_object('roots',coalesce((select json_group_array(json(root_json)) from (select $ROOT_JSON as root_json from nodes r where r.parent_id is null and r.removed_at is null order by r.name)),json('[]'))));")"
echo "Total response bytes: $TOTAL"
echo "Estimated tokens (~chars/4): $(((TOTAL + 3) / 4))"
