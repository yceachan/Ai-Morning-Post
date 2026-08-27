#!/usr/bin/env bash
# Idempotent, unprivileged installer for a checkout on the VPS.
#
# Default scheduling is user crontab because user systemd managers stop when
# the account logs out unless an administrator enables linger. Use
# --scheduler systemd after that prerequisite has been handled.
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: deploy/install.sh [options]

Options:
  --app-dir DIR       Application checkout (default: ~/work/Ai-Morning-Post)
  --scheduler NAME    cron (default) or systemd
  --skip-build        Do not run npm install/build
  --dry-run           Print changes without modifying files or crontab
  -h, --help          Show this help

Environment overrides:
  AI_MORNING_POST_DIR, AI_MORNING_POST_SCHEDULER
USAGE
}

die() {
  printf 'ai-morning-post install: %s\n' "$*" >&2
  exit 1
}

say() {
  printf 'ai-morning-post install: %s\n' "$*"
}

app_dir="${AI_MORNING_POST_DIR:-${HOME}/work/Ai-Morning-Post}"
scheduler="${AI_MORNING_POST_SCHEDULER:-cron}"
skip_build=0
dry_run=0

while (($#)); do
  case "$1" in
    --app-dir)
      (($# >= 2)) || die '--app-dir requires a value'
      app_dir="$2"
      shift 2
      ;;
    --scheduler)
      (($# >= 2)) || die '--scheduler requires cron or systemd'
      scheduler="$2"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$scheduler" in
  cron|systemd) ;;
  *) die "unsupported scheduler '$scheduler' (use cron or systemd)" ;;
esac

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

[[ -d "$app_dir" ]] || die "application directory does not exist: $app_dir"
app_dir="$(CDPATH= cd -- "$app_dir" && pwd)"
[[ -f "$app_dir/package.json" ]] || die "package.json not found in $app_dir"

if ((dry_run)); then
  say "dry-run: checkout $app_dir"
  say "dry-run: ensure data/, logs/, and backups/ (mode 700)"
  if [[ ! -f "$app_dir/config.toml" ]]; then
    say "dry-run: copy deploy/config.toml.example to config.toml (mode 600)"
  else
    say "dry-run: preserve existing config.toml and set mode 600"
  fi
  if ((skip_build)); then
    say 'dry-run: skip npm install/build'
  else
    say 'dry-run: run npm ci (or npm install when package-lock.json is absent) and npm run build'
  fi
  if [[ "$scheduler" == cron ]]; then
    say 'dry-run: replace the managed cron entry with a single */15 run'
  else
    say 'dry-run: install and enable the user systemd timer'
  fi
  exit 0
fi

command -v node >/dev/null 2>&1 || die 'node is required (Node 24+ required)'
command -v npm >/dev/null 2>&1 || die 'npm is required'
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] || die 'could not determine Node.js version'
((node_major >= 24)) || die "Node.js 24+ is required (found $node_major)"

install -d -m 700 "$app_dir/data" "$app_dir/logs" "$app_dir/backups"

template="$app_dir/deploy/config.toml.example"
if [[ ! -f "$app_dir/config.toml" ]]; then
  [[ -f "$template" ]] || die "missing config template: $template"
  install -m 600 "$template" "$app_dir/config.toml"
  say "created $app_dir/config.toml from the secret-free template"
else
  chmod 600 "$app_dir/config.toml"
  say 'preserved existing config.toml (mode 600)'
fi

chmod 755 "$app_dir/scripts/run-job.sh" "$app_dir/scripts/backup.sh"

if ((skip_build == 0)); then
  cd "$app_dir"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    say 'package-lock.json is absent; falling back to npm install'
    npm install
  fi
  npm run build
else
  say 'skipping dependency installation and build by request'
fi

[[ -f "$app_dir/dist/cli.js" ]] || die "built CLI not found: $app_dir/dist/cli.js"

shell_quote() {
  # POSIX single-quote escaping; cron invokes /bin/sh.
  local value="$1"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

install_cron() {
  command -v crontab >/dev/null 2>&1 || die 'crontab is required for --scheduler cron'
  local marker='ai-morning-post managed cron'
  local script_path log_path cron_line tmp filtered
  script_path="$(shell_quote "$app_dir/scripts/run-job.sh")"
  log_path="$(shell_quote "$app_dir/logs/cron.log")"
  cron_line="*/15 * * * * $script_path >> $log_path 2>&1 # $marker"
  tmp="$(mktemp)"
  filtered="${tmp}.filtered"
  trap 'rm -f -- "$tmp" "$filtered"' RETURN

  # crontab -l returns 1 when the user has no existing crontab; that is not an
  # error. Every unrelated line is copied byte-for-byte through awk.
  crontab -l >"$tmp" 2>/dev/null || :
  awk -v marker="$marker" 'index($0, marker) == 0 { print }' "$tmp" >"$filtered"
  printf '%s\n' "$cron_line" >>"$filtered"
  crontab "$filtered"
  trap - RETURN
  rm -f -- "$tmp" "$filtered"
  say 'installed one managed cron entry (every 15 minutes)'
}

install_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  command -v systemctl >/dev/null 2>&1 || die 'systemctl is required for --scheduler systemd'
  install -d -m 700 "$unit_dir"
  install -m 644 "$app_dir/deploy/systemd/ai-morning-post.service" "$unit_dir/ai-morning-post.service"
  install -m 644 "$app_dir/deploy/systemd/ai-morning-post.timer" "$unit_dir/ai-morning-post.timer"
  if ! systemctl --user daemon-reload; then
    die 'user systemd is unavailable; ask an administrator to run loginctl enable-linger "$USER", then retry'
  fi
  if ! systemctl --user enable --now ai-morning-post.timer; then
    die 'could not enable the user timer; inspect systemctl --user status'
  fi
  say 'installed and enabled the user systemd timer'
}

case "$scheduler" in
  cron) install_cron ;;
  systemd) install_systemd ;;
esac

say "installation complete; config: $app_dir/config.toml"
say 'run scripts/run-job.sh manually for one scheduled-equivalent cycle'
