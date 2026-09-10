#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Deploy Bravo Secure services to the Contabo staging box.
#
# Mechanism (the proven manual flow, scripted): rsync each service's source
# into ~/bravo on the box, then `docker compose build <svc>` and
# `up -d <svc>`, then verify the container is healthy. The Docker build runs
# the service's own typecheck/build (next build / nest build with
# ignoreBuildErrors=false), so a broken commit fails the build and the old
# container keeps running — build gates deploy.
#
# ⚠️  main is the source of truth. rsync uses --delete, so any file that
#     exists on the box but not in this checkout is removed. Server-side
#     hotfixes MUST be committed to main or they will be overwritten.
#     (.env* and build artefacts are excluded from the sync — see below.)
#
# Usage (local):
#   SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh ops-console
#   scripts/deploy-staging.sh all
#   scripts/deploy-staging.sh auth-service ops-console
#
# Usage (CI): the workflow exports BOX_* + writes the key to $SSH_KEY.
#
# Environment:
#   BOX_HOST   default 94.136.184.52
#   BOX_USER   default admin
#   BOX_DIR    default /home/admin/bravo
#   SSH_KEY    private key path; default ~/.ssh/bravo-staging.pem
#   COMPOSE    default docker-compose.staging.yml
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOX_HOST="${BOX_HOST:-94.136.184.52}"
BOX_USER="${BOX_USER:-admin}"
BOX_DIR="${BOX_DIR:-/home/admin/bravo}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/bravo-staging.pem}"
COMPOSE="${COMPOSE:-docker-compose.staging.yml}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
REMOTE="$BOX_USER@$BOX_HOST"
# Common excludes: never ship local deps/build output or any env/secret file.
RSYNC_EXCLUDES=(--exclude node_modules --exclude .next --exclude dist
                --exclude '.env' --exclude '.env.*' --exclude '*.tsbuildinfo'
                --exclude .git)

ALL_SERVICES=(auth-service messenger-service ops-console)

# Resolve requested services.
if [[ $# -eq 0 || "${1:-}" == "all" ]]; then
  SERVICES=("${ALL_SERVICES[@]}")
else
  SERVICES=("$@")
fi

log()  { printf '\033[1;36m>> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ── TOOL PREFLIGHT (2026-08-20) ───────────────────────────────────────────
# `rsync` is NOT present in Git Bash on Windows, which is where this repo is
# developed. Without this check the sync step printed
#     rsync: command not found
# and the script CARRIED ON to build and restart the container — from the
# source already on the box. It reported success, exited 0, and deployed
# nothing: a green deploy of stale code, which is strictly worse than a
# failed one. (`set -e` does not catch it: the failure is inside a function
# whose result feeds a loop, and the final `up -d` then succeeds.)
#
# Fail loudly instead, and name the escape hatch that actually works here.
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed or not on PATH.
  This script cannot deploy without it — and a missing $1 previously let the
  script 'succeed' while shipping nothing (2026-08-20).
  On Windows/Git Bash rsync is absent; either run this from WSL, or ship the
  service manually:
    tar czf /tmp/svc.tgz --exclude=node_modules --exclude=dist --exclude='.env*' -C apps <service>
    scp -i \$SSH_KEY /tmp/svc.tgz $BOX_USER@$BOX_HOST:/tmp/
    ssh -i \$SSH_KEY $BOX_USER@$BOX_HOST 'cd $BOX_DIR/apps && tar xzf /tmp/svc.tgz \\
      && cd $BOX_DIR && docker compose -f $COMPOSE build <service> \\
      && docker compose -f $COMPOSE up -d <service>'
  Then VERIFY the new code is in the running container (grep dist/ for a symbol
  your change added) — never trust the exit code alone."
}
need_cmd rsync
need_cmd ssh

# ── B-376 stale-checkout guard ────────────────────────────────────────────
# On 2026-08-04 this script was run from a ~July feature-branch checkout:
# `rsync --delete` made the box tree equal that checkout, silently removing
# ~6 weeks of shipped auth-service code (pro-applications 404'd for an ACTIVE
# Pro member) while /ready stayed green. The box is built FROM this checkout,
# so the checkout must contain everything already on origin/main.
#
# Rule: refuse to deploy unless origin/main is an ANCESTOR of HEAD. That
# rejects both a behind-main checkout and a stale feature branch, while still
# allowing uncommitted local changes (sessions deploy work-in-progress) and
# up-to-date feature branches that include main.
#
# Emergency override (rolling BACK on purpose, GitHub unreachable, …):
#   ALLOW_STALE=1 scripts/deploy-staging.sh <svc>
stale_guard() {
  if [[ "${ALLOW_STALE:-}" == "1" ]]; then
    log "ALLOW_STALE=1 — skipping the stale-checkout guard (B-376). You own the result."
    return 0
  fi
  git -C "$REPO_ROOT" fetch origin main --quiet \
    || fail "cannot fetch origin/main to verify this checkout is current (B-376 guard).
   No network? Deploying anyway risks re-wiping newer code off the box.
   Override only if you are CERTAIN: ALLOW_STALE=1 $0 ${SERVICES[*]}"
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor origin/main HEAD; then
    local behind
    # `|| echo "?"` — if origin/main is unresolvable the count also fails;
    # without the fallback, set -e would kill the script HERE and mask the
    # explanation below.
    behind=$(git -C "$REPO_ROOT" rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
    fail "this checkout is missing $behind commit(s) that are on origin/main (B-376 guard).
   rsync --delete would DELETE that newer code from the box and deploy the stale build
   (this exact accident took Pro offline on 2026-08-04). Fix:
     git pull --rebase origin main    # then re-run the deploy
   Emergency override (deliberate rollback only): ALLOW_STALE=1 $0 ${SERVICES[*]}"
  fi
  log "stale-checkout guard OK — origin/main is contained in HEAD"
}
stale_guard

rsync_to_box() { # <local-relative> <remote-relative>
  rsync -az --delete "${RSYNC_EXCLUDES[@]}" -e "ssh ${SSH_OPTS[*]}" \
    "$REPO_ROOT/$1/" "$REMOTE:$BOX_DIR/$2/"
}

sync_service() {
  case "$1" in
    auth-service)       rsync_to_box apps/auth-service apps/auth-service ;;
    messenger-service)  rsync_to_box apps/messenger-service apps/messenger-service
                        rsync_to_box packages/messenger-core packages/messenger-core ;;
    ops-console)        # build context is the box repo root → app + shared pkg + root .dockerignore
                        rsync_to_box apps/ops-console apps/ops-console
                        rsync_to_box packages/messenger-core packages/messenger-core
                        rsync -az -e "ssh ${SSH_OPTS[*]}" "$REPO_ROOT/.dockerignore" "$REMOTE:$BOX_DIR/.dockerignore" ;;
    *) fail "unknown service '$1' (expected: ${ALL_SERVICES[*]})" ;;
  esac
}

for svc in "${SERVICES[@]}"; do
  case " ${ALL_SERVICES[*]} " in *" $svc "*) : ;; *) fail "unknown service '$svc'";; esac
done

log "deploying to $REMOTE:$BOX_DIR — services: ${SERVICES[*]}"
ssh "${SSH_OPTS[@]}" "$REMOTE" "test -f '$BOX_DIR/$COMPOSE'" || fail "compose file $BOX_DIR/$COMPOSE not found on box"

# AUDIT-2026-08-13 #6 — messenger-service fails CLOSED on every /push/*
# request when APP_CHECK_MODE is unset or unrecognized under
# NODE_ENV=production (app-check.guard.ts; the image bakes production in).
# The box compose is NOT in the repo, so verify BEFORE any rsync/build that
# the var resolves to a RECOGNIZED VALUE on the messenger-service block —
# presence alone is not enough (an empty/typo'd value also fails closed, and
# a var on a different service doesn't help). Runs in the preamble so a
# blocked deploy leaves the box completely untouched — no synced source, no
# built image, no partial multi-service deploy. NOTE this gate only covers
# THIS script: the rollback lane and the box watchdog run `up -d` directly,
# which is why the guard itself degrades to scoped fail-closed rather than
# refusing to boot. Fix on the box: add to the messenger-service
# environment block in $COMPOSE:  APP_CHECK_MODE: 'warn-only'
# ('warn-only' until clients ship X-Firebase-AppCheck, then 'enforce').
# Emergency override mirrors ALLOW_STALE (B-376): a false-block here must
# never make messenger undeployable during an incident.
#   ALLOW_APPCHECK_UNVERIFIED=1 scripts/deploy-staging.sh messenger-service
case " ${SERVICES[*]} " in
  *" messenger-service "*)
    if [[ "${ALLOW_APPCHECK_UNVERIFIED:-}" == "1" ]]; then
      log "ALLOW_APPCHECK_UNVERIFIED=1 — skipping the APP_CHECK_MODE preflight (audit #6). You own the result."
    else
      # Capture first: `grep -q` closing the pipe early would SIGPIPE ssh
      # under pipefail (rc=141) and false-block a CORRECT config; capturing
      # also separates "cannot read the box" from "value doesn't resolve".
      # Key match is case-SENSITIVE and line-anchored (a lowercase or
      # prefixed key would export a name the guard never reads); the value
      # must be lowercase exactly as the runbook prescribes — a case-funky
      # value blocks the deploy (safe) rather than passing unverified.
      if ! rendered=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' config messenger-service"); then
        fail "cannot read the box compose (ssh or 'docker compose config' failed) — APP_CHECK_MODE not verified; nothing was synced or built. Override (you own it): ALLOW_APPCHECK_UNVERIFIED=1"
      fi
      if printf '%s\n' "$rendered" | grep -Eq "^[[:space:]]*APP_CHECK_MODE:[[:space:]]*[\"']?(warn-only|enforce|disabled)[\"']?[[:space:]]*\$"; then
        log "APP_CHECK_MODE resolves to a recognized mode on the box's messenger-service block"
      else
        seen=$(printf '%s\n' "$rendered" | grep -E 'APP_CHECK' || echo '<no APP_CHECK_MODE line rendered>')
        fail "APP_CHECK_MODE does not resolve to warn-only|enforce|disabled on the box's messenger-service compose block — /push/* would fail closed on the next container (app-check.guard.ts, audit #6). Rendered: ${seen}. Fix it on the box FIRST; nothing was synced or built"
      fi
    fi
    ;;
esac

for svc in "${SERVICES[@]}"; do
  log "sync $svc"
  sync_service "$svc"
  log "build $svc (this also typechecks the service)"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' build $svc" \
    || fail "build failed for $svc — NOT restarting; previous container stays up"
  log "restart $svc"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' up -d $svc"
done

log "waiting for healthchecks…"
rc=0
# Poll each service's health for up to ~2min. A container's healthcheck sits
# in "starting" for the first several probes after a restart, so we must wait
# for it to settle rather than check once — but a genuinely broken container
# (crash-loop) never reaches healthy and correctly fails after the timeout.
HEALTH_ATTEMPTS=40   # × 3s ≈ 120s
for svc in "${SERVICES[@]}"; do
  status=starting
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    status=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && cid=\$(docker compose -f '$COMPOSE' ps -q $svc) && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \$cid" 2>/dev/null || echo "unknown")
    # "healthy" (has healthcheck) or "running" (no healthcheck) = done.
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then break; fi
    sleep 3
  done
  case "$status" in
    healthy|running) printf '\033[1;32mOK   %s -> %s\033[0m\n' "$svc" "$status" ;;
    *)               printf '\033[1;31mFAIL %s -> %s\033[0m\n' "$svc" "$status"; rc=1 ;;
  esac
done

# ── B-376 feature-route probes ────────────────────────────────────────────
# A stale image can be "healthy" while missing whole modules (/ready stayed
# green through both wipes). Probe one guarded feature route per service:
# 401/403 = module present + guarded; 404 = the image is missing code.
#
# B-706 (2026-08-30): the method matters. `hourly-checkin` is a @Post route, and this
# helper only ever sent GET — so an unmatched method returned 404 and the probe reported
# "image likely missing modules" on a perfectly good build. A false FAIL here is not
# harmless: it aborts the deploy before the watchdog snapshot refresh, leaving the box
# running new code behind a stale pristine snapshot. Fourth arg = method (default GET).
probe() { # <svc> <url> <expect-regex> [method]
  local code method="${4:-GET}"
  code=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X $method -H 'Content-Type: application/json' -d '{}' '$2'" 2>/dev/null || echo "000")
  if [[ "$code" =~ $3 ]]; then
    printf '\033[1;32mOK   %s feature probe -> %s\033[0m\n' "$1" "$code"
  else
    printf '\033[1;31mFAIL %s feature probe %s -> %s (expected %s) — image likely missing modules (stale build?)\033[0m\n' "$1" "$2" "$code" "$3" >&2
    rc=1
  fi
}
for svc in "${SERVICES[@]}"; do
  case "$svc" in
    auth-service)
      # Two families, so a partial tree can't hide behind one green route.
      probe auth-service "http://localhost:3001/pro-applications/me" '^(401|403)$'
      probe auth-service "http://localhost:3001/agents/me/missions/00000000-0000-0000-0000-000000000000/hourly-checkin" '^(401|403)$' POST
      # B-706 — the durable-dismiss route. 404 here means the image predates the
      # notification-inbox fix while the DB already has `dismissed_at`.
      probe auth-service "http://localhost:3001/me/notifications/dismiss" '^(401|403)$' POST
      ;;
    ops-console)
      # A route that only exists in a CURRENT build — `/` answers 200 from a
      # stale image too, so it proves liveness, not freshness.
      probe ops-console "http://localhost:3002/pro-applications" '^(200|3[0-9][0-9])$'
      ;;
    messenger-service)
      # Port 3100, and /healthz — verified against the live box (/health is 404).
      probe messenger-service "http://localhost:3100/healthz" '^200$'
      ;;
  esac
done

# Refresh the box-side known-good snapshot the self-heal watchdog restores
# from (see docs/runbooks + sqa.md B-376). Only after a fully green deploy —
# the stale-checkout guard above already proved this tree contains main.
if [[ $rc -eq 0 ]]; then
  log "refreshing watchdog pristine snapshot from the just-deployed tree"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "set -e; cd '$BOX_DIR' && mkdir -p /home/admin/bravo-watchdog \
    && tar czf /home/admin/bravo-watchdog/pristine-main.tgz.tmp \
         --exclude node_modules --exclude dist --exclude .next \
         --exclude '.env' --exclude '.env.*' --exclude '*.tsbuildinfo' \
         apps/auth-service apps/ops-console apps/messenger-service packages/messenger-core .dockerignore \
    && mv /home/admin/bravo-watchdog/pristine-main.tgz.tmp /home/admin/bravo-watchdog/pristine-main.tgz" \
    || log "WARN: snapshot refresh failed (deploy itself is fine; watchdog keeps its previous snapshot)"
fi

[[ $rc -eq 0 ]] && log "deploy complete ✓" || fail "one or more services unhealthy/incomplete — check: docker compose -f $COMPOSE logs <svc>"
exit $rc
