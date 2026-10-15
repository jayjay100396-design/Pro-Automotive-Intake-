#!/bin/bash
# Stellar Glass deploy guard. firebase.json runs it before every `firebase deploy` target (predeploy).
# It refuses a deploy unless:
#   - it goes to the Firebase project stellar-glass-jobs,
#   - the command names its targets with --only (a bare `firebase deploy` also pushes every Cloud Functions
#     codebase, including ones still waiting on their secrets; use the npm scripts in package.json),
#   - the checkout is clean and is exactly the current head of the main app branch on GitHub, so nothing
#     unpushed, half-merged or older than what's live replaces it,
#   - the JavaScript parses and the unit tests pass.
# It works from any folder, so a fresh clone deploys the same way as an existing checkout.
# STELLAR_DEPLOY_BRANCH names a different branch to deploy on purpose.

cd "${PROJECT_DIR:-$(dirname "$0")/..}" || exit 1
BRANCH="${STELLAR_DEPLOY_BRANCH:-claude/project-thread-5lc6hk}"

fail() {
  echo "" >&2
  echo "STOP — Stellar Glass deploy refused: $1" >&2
  exit 1
}

project="${GCLOUD_PROJECT:-}"
[ -n "$project" ] || project=$(sed -n 's/.*"default": *"\([^"]*\)".*/\1/p' .firebaserc 2>/dev/null)
[ "$project" = "stellar-glass-jobs" ] || fail "the Firebase project is '$project', not stellar-glass-jobs."

# The firebase command that started this hook, found by walking up the process tree. (A deploy started some
# other way, such as from the Firebase MCP server, has no such command line, and this check is skipped.)
pid=$PPID
cmd=""
for _ in 1 2 3 4 5 6 7 8; do
  { [ -n "$pid" ] && [ "$pid" -gt 1 ]; } 2>/dev/null || break
  args=$(ps -o args= -p "$pid" 2>/dev/null)
  case "$args" in *firebase*" deploy"*) cmd="$args"; break ;; esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
if [ -n "$cmd" ]; then
  case "$cmd" in
    *" --only "*|*" --only="*) ;;
    *) fail "name what to deploy with --only, or use npm run deploy, deploy:rules, deploy:functions, deploy:calendar, deploy:alerts or deploy:parts. A bare 'firebase deploy' would also deploy every functions codebase." ;;
  esac
fi

git rev-parse --git-dir >/dev/null 2>&1 || fail "this folder is not a git checkout."

dirty=$(git status --porcelain --untracked-files=all -- public functions functions-calendar functions-alerts functions-parts firestore.rules storage.rules firebase.json firestore.indexes.json prompts scripts)
[ -z "$dirty" ] || fail "these files have changes that aren't committed:
$dirty"

git fetch -q origin "$BRANCH" 2>/dev/null || fail "couldn't reach GitHub to check that this is the latest $BRANCH."
[ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ] \
  || fail "this checkout is at $(git rev-parse --short HEAD), but $BRANCH on GitHub is at $(git rev-parse --short FETCH_HEAD). Pull it fresh (or clone it) and deploy that exact head."

echo "deploy guard: checking JS syntax and running unit tests..."
for f in public/js/*.js public/js/takeoff/*.js; do
  node --check "$f" >/dev/null 2>&1 || fail "syntax error in $f"
done
npx --no mocha "test/*.test.mjs" >/dev/null 2>&1 || fail "the unit tests (npx mocha 'test/*.test.mjs') failed, or npm ci hasn't been run in this folder."

echo "deploy guard: OK — deploying $BRANCH at $(git rev-parse --short HEAD) to stellar-glass-jobs from $(pwd -P)"
