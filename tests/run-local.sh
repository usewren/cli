#!/bin/sh
# Run the CLI tests (bun test --coverage) against a throwaway WREN server.
#
#   sh tests/run-local.sh [extra bun test args…]
#
# Builds the server image from the WREN sources (the folder holding sandbox/, db/,
# auth/ …; default: this repo's parent, override with WREN_SOURCES), starts
# Postgres + the server on a private Docker network, runs the tests in a
# container on that network, and removes everything again. All names are
# prefixed wrenC- (override with WREN_NAME). No host ports are published.
# The image is only rebuilt when missing; set REBUILD=1 to force a build.
set -e
export MSYS_NO_PATHCONV=1
REPO=$(cd "$(dirname "$0")/.." && pwd)
SOURCES=${WREN_SOURCES:-$(cd "$REPO/.." && pwd)}
NAME=${WREN_NAME:-wrenC}
IMG="wren:$NAME"

# Docker on Windows (Git Bash) wants W:/path rather than /w/path for volumes
hostpath() { case "$1" in /[a-zA-Z]/*) echo "$(echo "$1" | cut -c2 | tr a-z A-Z):$(echo "$1" | cut -c3-)";; *) echo "$1";; esac; }

cleanup() {
  docker rm -fv "$NAME-app" "$NAME-db" >/dev/null 2>&1 || true
  docker network rm "$NAME-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

if [ -n "$REBUILD" ] || ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "Building $IMG from $SOURCES ..."
  (cd "$SOURCES" && docker build -q -f sandbox/Dockerfile -t "$IMG" .) >/dev/null
fi

docker network create "$NAME-net" >/dev/null
docker run -d --rm --name "$NAME-db" --network "$NAME-net" \
  -e POSTGRES_USER=wren -e POSTGRES_PASSWORD=wren -e POSTGRES_DB=wren postgres:17-alpine >/dev/null
for i in $(seq 1 30); do docker exec "$NAME-db" pg_isready -U wren >/dev/null 2>&1 && break; sleep 1; done; sleep 2

docker run -d --rm --name "$NAME-app" --network "$NAME-net" \
  -e DATABASE_URL="postgres://wren:wren@$NAME-db:5432/wren" \
  -e BETTER_AUTH_SECRET=test-secret-test-secret-test-secret \
  -e BETTER_AUTH_URL="http://$NAME-app:4000" \
  -e CACHE_PURGE_BACKEND=noop \
  -e WREN_WEBHOOK_ALLOW_HOSTS=localhost \
  "$IMG" >/dev/null
for i in $(seq 1 60); do
  docker exec "$NAME-app" bun -e 'const r = await fetch("http://localhost:4000/health"); process.exit(r.ok ? 0 : 1)' >/dev/null 2>&1 && break
  sleep 1
done

TEST_CMD='bun install --frozen-lockfile && bun test --coverage'
docker run --rm --network "$NAME-net" \
  -v "$(hostpath "$REPO"):/src" -w /src \
  -e WREN_URL="http://$NAME-app:4000" \
  oven/bun:1 sh -c "$TEST_CMD $*" || STATUS=$?
exit ${STATUS:-0}
