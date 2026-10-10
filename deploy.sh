#!/usr/bin/env bash
# Publishes the latest version from GitHub: run ./deploy.sh in this folder on the server.
# It backs up the database, pulls the code, rebuilds and restarts the app,
# and waits until the app reports healthy. Your data in ./data is kept.
set -euo pipefail
cd "$(dirname "$0")"

# Use sudo for Docker only when this user isn't allowed to use it directly,
# so git still runs as you and the files stay yours.
docker=(docker)
docker info >/dev/null 2>&1 || docker=(sudo docker)
compose=("${docker[@]}" compose)

if [[ ! -f .env ]]; then
  echo "There's no .env yet: run 'cp .env.example .env' and fill it in first." >&2
  exit 1
fi
# With DOMAIN set, Caddy serves the site over https.
if grep -Eq '^DOMAIN=.+' .env; then compose+=(--profile https); fi

if [[ -n "$("${compose[@]}" ps -q app 2>/dev/null)" ]]; then
  echo "==> Backing up the database"
  "${compose[@]}" exec -T app node scripts/backup.js || echo "Backup failed; continuing." >&2
fi

echo "==> Pulling the latest code"
git pull --ff-only

echo "==> Building and starting"
"${compose[@]}" up -d --build --remove-orphans

echo "==> Waiting for the app to be ready"
container=$("${compose[@]}" ps -q app)
for _ in $(seq 1 60); do
  status=$("${docker[@]}" inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)
  if [[ $status == healthy ]]; then
    "${docker[@]}" image prune -f >/dev/null # old builds would slowly fill the disk
    echo "Done: the app is running."
    exit 0
  fi
  sleep 3
done
echo "The app didn't become healthy. Its last log lines:" >&2
"${compose[@]}" logs --tail 40 app >&2
exit 1
