#!/usr/bin/env bash
#
# git-push-initial.sh — first push of this working tree to a NEW, EMPTY GitHub repo.
# Run ON YOUR MAC (it needs your GitHub credentials):
#
#     bash scripts/git-push-initial.sh
#
# Why a script and not four commands: `.gitignore` blanket-ignores `android/`,
# and the 24 curated files under it (manifest, gradle files, hand-written
# Kotlin, resources) are the SOURCE OF TRUTH for scripts/mac-android-prebuild.sh.
# A plain `git add -A` silently drops every one of them; the box would then
# prebuild a vanilla project with no call service, no CallKeep, no AEC override.
# This script force-adds exactly that set, and refuses to run if anything
# secret-shaped is about to be committed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPO="${REPO:-https://github.com/digital7rdr/bravosecure-main.git}"
BRANCH="${BRANCH:-main}"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "Pre-flight"
command -v git >/dev/null || die "git not found"
if [[ -d .git ]] && git rev-parse HEAD >/dev/null 2>&1; then
  die "this tree already has commits — this script is for the FIRST push only. Use plain git from here."
fi
# A .git left behind by the sandbox has stale lock files it could not remove.
rm -rf .git
git init -q -b "$BRANCH"
ok "fresh repository on branch $BRANCH"

say "Staging"
git add -A
# The curated android/ set — see header. Anything else under android/ stays ignored.
CURATED=(
  android/build.gradle
  android/gradle.properties
  android/app/build.gradle
  android/app/google-services.json
  android/app/proguard-rules.pro
  android/app/src/main/AndroidManifest.xml
  android/app/src/main/res/values/colors.xml
  android/app/src/main/res/values/styles.xml
  android/app/src/main/res/drawable/ic_stat_bravo.xml
)
while IFS= read -r f; do CURATED+=("$f"); done < <(find android/app/src/main/java -name '*.kt' | sort)
for f in "${CURATED[@]}"; do [[ -f "$f" ]] || die "curated file missing: $f (run scripts/mac-android-prebuild.sh first?)"; done
git add -f "${CURATED[@]}"
ok "$(git diff --cached --name-only | wc -l | tr -d ' ') files staged (${#CURATED[@]} force-added under android/)"

say "Secret gate"
staged="$(git diff --cached --name-only)"
# Key material and secret dirs: blocked on the NAME, no exceptions.
bad="$(printf '%s\n' "$staged" | grep -iE 'secrets/|service-account|\.pem$|\.p8$|\.p12$|\.keystore$|\.jks$' || true)"
[[ -z "$bad" ]] || die "refusing: key material is staged:
$bad"
# Env files: judged on CONTENT. A committed env file is fine when every key is
# a *_PUBLIC_* build input (EXPO_PUBLIC_/NEXT_PUBLIC_ are compiled into the
# client bundle and are public by contract). One non-public key blocks the push.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  nonpublic="$(git show ":$f" | grep -vE '^\s*(#|$)' | grep -vE '^\s*[A-Z0-9_]*_PUBLIC_[A-Z0-9_]+=' || true)"
  [[ -z "$nonpublic" ]] || die "refusing: $f is staged and carries non-public keys:
$(printf '%s\n' "$nonpublic" | sed -E 's/=.*/=…/' | head -5)"
  ok "$f: only *_PUBLIC_* keys — allowed"
done < <(printf '%s\n' "$staged" | grep -iE '(^|/)\.env($|\.)' | grep -vE '\.example$' || true)
if git diff --cached | grep -qE -- '^\+.*(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|"private_key"|sk\.eyJ|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30})'; then
  die "refusing: a private key or secret token appears in the staged diff"
fi
ok "no secret-shaped paths or contents"

say "Commit"
git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo SudeeshRobert)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo sudeeshroberttj@gmail.com)}" \
  commit -q -F - <<'MSG'
Bravo Secure — production baseline for bravosecure.cloud

Imported from the 2026-08-31 source drop, plus:

- deploy/production: tracked compose, Caddyfile, bootstrap and env
  generator for 31.97.126.211 (self-hosted Supabase, MinIO, coturn,
  GlitchTip; FCM and Mapbox remain)
- auth-service: AUTH_SECOND_FACTOR=totp — authenticator-app second
  factor for login/registration with challenge binding; vault-PIN reset
  follows; 15 new tests, suite green
- ops-console: TOTP enrolment on first login (QR, manual key, backup
  codes); sender-cert public key baked at build
- android: scripts/mac-android-prebuild.sh reconstitutes a buildable
  tree from the 24 curated files without losing the hand-written parts;
  app.json gains android.googleServicesFile (prebuild aborted without it)
- expo: config/staging.env + *:staging:mac scripts — a root .env*.local
  breaks the SDK 54 dev bundle
- runbooks: MAC_QUICKSTART, MAC_OPS_CONSOLE, deploy/production/README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C5wT7YzM91d72FZeybYUTu
MSG
ok "$(git log -1 --format='%h %s')"

say "Push → $REPO ($BRANCH)"
git remote add origin "$REPO"
git push -u origin "$BRANCH"
ok "pushed"
printf '\n  Next: on the VPS —  git clone %s /opt/bravo && bash /opt/bravo/deploy/production/bootstrap.sh\n\n' "$REPO"
