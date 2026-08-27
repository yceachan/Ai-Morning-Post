#!/usr/bin/env bash
# Make a recoverable SQLite backup for the single-user deployment.
set -Eeuo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="${AI_MORNING_POST_DIR:-$(CDPATH= cd -- "$script_dir/.." && pwd)}"
data_dir="${AI_MORNING_POST_DATA_DIR:-$app_dir/data}"
backup_dir="${AI_MORNING_POST_BACKUP_DIR:-$app_dir/backups}"
db_path="${AI_MORNING_POST_DB:-$data_dir/ai-morning-post.sqlite}"
keep_days="${AI_MORNING_POST_BACKUP_KEEP_DAYS:-14}"

if [[ ! -d "$app_dir" ]]; then
  printf 'ai-morning-post: application directory does not exist: %s\n' "$app_dir" >&2
  exit 78
fi
if [[ ! -f "$db_path" ]]; then
  # Permit the application to choose app.db without forcing a migration just
  # for the backup helper.
  if [[ -f "$data_dir/newsletter.sqlite3" ]]; then
    db_path="$data_dir/newsletter.sqlite3"
  elif [[ -f "$data_dir/app.db" ]]; then
    db_path="$data_dir/app.db"
  else
    printf 'ai-morning-post: database not found: %s\n' "$db_path" >&2
    exit 78
  fi
fi
if ! [[ "$keep_days" =~ ^[0-9]+$ ]]; then
  printf 'ai-morning-post: backup retention must be a non-negative integer\n' >&2
  exit 2
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_dir/newsletter-$stamp.sqlite3"

if command -v sqlite3 >/dev/null 2>&1; then
  # .backup is safe while the application is running and includes a
  # transactionally consistent snapshot.
  sqlite3 "$db_path" ".backup '$backup_file'"
else
  # sqlite3 is optional on a minimal VPS. The service is single-process and
  # short-lived; copy the main file and any sidecars when the CLI is idle.
  cp --reflink=auto -- "$db_path" "$backup_file"
fi
chmod 600 "$backup_file"

# Retention is scoped to the exact backup directory and filename pattern.
find "$backup_dir" -maxdepth 1 -type f -name 'newsletter-*.sqlite3' -mtime "+$keep_days" -delete
printf 'Created backup: %s\n' "$backup_file"
