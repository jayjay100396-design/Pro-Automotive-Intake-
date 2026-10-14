#!/bin/bash
# Stellar Glass deploy guard — runs automatically before every `firebase deploy` (firebase.json predeploy).
# Blocks any deploy from the wrong folder, wrong Firebase project, dirty git checkout, or broken tests.

cd "${PROJECT_DIR:-$(dirname "$0")/..}" || exit 1
REAL_DIR="$(pwd -P)"
CANONICAL_DIR="/Users/Jay/.gemini/antigravity-ide/scratch/stellar-glass"

fail() {
  echo "" >&2
  echo "STOP — Stellar Glass deploy refused: $1" >&2
  echo "Only the canonical Stellar Glass repository ($CANONICAL_DIR)" >&2
  echo "pointing to Firebase project 'stellar-glass-jobs' can be deployed, and only after Jay says yes." >&2
  exit 1
}

[ "$REAL_DIR" = "$CANONICAL_DIR" ] || fail "current directory ($REAL_DIR) is not the canonical folder ($CANONICAL_DIR)."

grep -q '"stellar-glass-jobs"' .firebaserc 2>/dev/null || fail ".firebaserc does not point to stellar-glass-jobs."
grep -q 'stellar-glass-jobs' public/js/firebase.js 2>/dev/null || fail "public/js/firebase.js does not point to stellar-glass-jobs."

git rev-parse --git-dir >/dev/null 2>&1 || fail "this folder is not a git repository."

dirty=$(git status --porcelain --untracked-files=all -- public functions functions-calendar functions-alerts functions-parts firestore.rules storage.rules firebase.json firestore.indexes.json)
[ -z "$dirty" ] || fail "these files have uncommitted changes:
$dirty"

echo "deploy guard: checking JS syntax and running unit tests..."
for f in public/js/*.js public/js/takeoff/*.js; do
  node --check "$f" >/dev/null 2>&1 || fail "syntax error in $f"
done
npx mocha "test/*.test.mjs" >/dev/null 2>&1 || fail "unit tests (npx mocha 'test/*.test.mjs') failed."

echo "deploy guard: OK — deploying Stellar Glass (stellar-glass-jobs) from $REAL_DIR at $(git rev-parse --short HEAD)"
