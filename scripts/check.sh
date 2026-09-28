#!/bin/sh
# Smoke-tests a deployed instance WITHOUT any secrets: it only exercises the paths
# that must refuse. A green run here means the endpoint is up, signed-request
# enforcement is on, and nothing is served that should not be.
#
#     sh scripts/check.sh                          # production
#     sh scripts/check.sh http://localhost:8787    # wrangler dev
set -eu
BASE="${1:-https://ig-reply.aswincloud.com}"
fail=0
expect() { # expect <code> <label> <curl args...>
  want="$1"; label="$2"; shift 2
  got=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then echo "  ok   $got  $label"; else echo "  FAIL $got  $label (wanted $want)"; fail=1; fi
}
echo "== $BASE =="
# /health is 200 when fully configured and 503 before secrets are set or when the
# token is about to expire. Both prove the Worker is up; anything else does not.
code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$BASE/health")
case "$code" in
  200) echo "  ok   200  /health: configured" ;;
  503) echo "  ok   503  /health: up, not yet configured (expected before secrets)" ;;
  *)   echo "  FAIL $code  /health"; fail=1 ;;
esac
expect 403 "webhook handshake with wrong verify token is refused" \
  "$BASE/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=x"
expect 401 "unsigned webhook POST is refused" -X POST -H 'content-type: application/json' -d '{}' "$BASE/webhook"
expect 401 "wrongly signed webhook POST is refused" -X POST -H 'content-type: application/json' \
  -H 'x-hub-signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' -d '{}' "$BASE/webhook"
expect 404 "unknown audio key is 404, not 500" "$BASE/audio/00000000-0000-0000-0000-000000000000"
expect 404 "audio key with bad shape is 404" "$BASE/audio/../etc/passwd"
expect 404 "unknown path" "$BASE/nope"
echo
echo "== /health =="
curl -s -m 15 "$BASE/health" | sed 's/^/  /'
echo
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || { echo "CHECKS FAILED"; exit 1; }
