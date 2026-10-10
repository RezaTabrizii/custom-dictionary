#!/bin/sh
# Publishes the latest version from GitHub: run ./deploy.sh (or sh deploy.sh) in this folder.
# It backs up the database, pulls the code, rebuilds and restarts the app,
# and waits until the app reports healthy. Your data in ./data is kept.
set -eu
cd "$(dirname "$0")"

# Use sudo for Docker only when this user isn't allowed to use it directly,
# so git still runs as you and the files stay yours.
SUDO=""
docker info >/dev/null 2>&1 || SUDO="sudo"

if [ ! -f .env ]; then
  echo "There's no .env yet: run 'cp .env.example .env' and fill it in first." >&2
  exit 1
fi
# With DOMAIN set, Caddy serves the site over https.
PROFILE=""
if grep -Eq '^DOMAIN=.+' .env; then PROFILE="--profile https"; fi

# $SUDO and $PROFILE are left unquoted on purpose: when empty they disappear.
compose() { $SUDO docker compose $PROFILE "$@"; }

if [ -n "$(compose ps -q app 2>/dev/null)" ]; then
  echo "==> Backing up the database"
  compose exec -T app node scripts/backup.js || echo "Backup failed; continuing." >&2
fi

echo "==> Pulling the latest code"
git pull --ff-only

echo "==> Building and starting"
compose up -d --build --remove-orphans

echo "==> Waiting for the app to be ready"
container=$(compose ps -q app)
tries=0
while [ "$tries" -lt 60 ]; do
  status=$($SUDO docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)
  if [ "$status" = healthy ]; then
    $SUDO docker image prune -f >/dev/null # old builds would slowly fill the disk
    echo "Done: the app is running."
    exit 0
  fi
  tries=$((tries + 1))
  sleep 3
done
echo "The app didn't become healthy. Its last log lines:" >&2
compose logs --tail 40 app >&2
exit 1
