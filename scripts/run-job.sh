#!/usr/bin/env bash
# Run one newsletter poll/send cycle from cron or a user systemd timer.
#
# cron has a deliberately small environment. Start a login-capable bash child,
# source both profile files explicitly, and only then exec Node. A profile
# error is fatal: sending without the expected SMTP credentials is worse than
# leaving the issue queued for the next run.
set -Eeuo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="${AI_MORNING_POST_DIR:-$(CDPATH= cd -- "$script_dir/.." && pwd)}"
app_entry="${AI_MORNING_POST_ENTRY:-$app_dir/dist/cli.js}"
app_config="${AI_MORNING_POST_CONFIG:-$app_dir/config.toml}"
if (($# > 0)); then
  app_arguments=("$@")
else
  app_arguments=(run)
fi

if [[ ! -d "$app_dir" ]]; then
  printf 'ai-morning-post: application directory does not exist: %s\n' "$app_dir" >&2
  exit 78
fi
if [[ ! -f "$app_config" ]]; then
  printf 'ai-morning-post: missing config file: %s\n' "$app_config" >&2
  printf 'Copy deploy/config.toml.example to config.toml and review it first.\n' >&2
  exit 78
fi
if [[ ! -f "$app_entry" ]]; then
  printf 'ai-morning-post: missing built CLI: %s\n' "$app_entry" >&2
  printf 'Run deploy/install.sh to install dependencies and build the application.\n' >&2
  exit 78
fi

cd "$app_dir"

# Prevent overlapping cron/manual runs from racing the SMTP delivery state.
# File descriptor 9 remains open across the exec below and therefore holds
# the lock for the complete fetch/render/send cycle.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$app_dir/data/run.lock"
  if ! flock -n 9; then
    printf 'ai-morning-post: another run is active; skipping\n'
    exit 0
  fi
fi

# Keep the application invocation in one place so cron and systemd have the
# same behavior. The CLI accepts the global --config option before `run`.
exec /usr/bin/env bash -c '
  set -o pipefail

  load_profile() {
    profile_file="$1"
    if [[ -r "$profile_file" ]]; then
      . "$profile_file"
      rc=$?
      if ((rc != 0)); then
        printf "ai-morning-post: failed to source %s (exit %s)\\n" "$profile_file" "$rc" >&2
        exit "$rc"
      fi
    fi
  }

  # ~/.profile is the conventional place for cron-safe POSIX exports. Do not
  # source shell-specific profiles here: this wrapper intentionally uses Bash.
  load_profile "$HOME/.profile"

  # systemd user services start with a minimal PATH. The bundled Node runtime
  # on the target VPS is exposed through ~/.local/bin, so make the conventional
  # user binary directories deterministic even if ~/.profile only contains
  # credential exports.
  export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

  if ! command -v node >/dev/null 2>&1; then
    printf "ai-morning-post: node was not found after loading ~/.profile; PATH=%s\n" "$PATH" >&2
    exit 127
  fi

  exec "$@"
' _ node "$app_entry" --config "$app_config" "${app_arguments[@]}"
