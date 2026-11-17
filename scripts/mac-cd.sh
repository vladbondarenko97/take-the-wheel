#!/bin/bash
# Pull-based CD for a Mac running Take the Wheel (com.takethewheel.deploy, every minute, installed by setup.mjs): when
# origin/main has commits this checkout lacks and GitHub Actions' CI passed them, fast-forward and reload what changed.
# Same shape as ~/dev/infra/deploy.sh (docs.vlad.yt projects/cicd-new-project.md, section B).
#   runner/, package*.json -> restart com.takethewheel.runner (npm install first if package*.json changed)
#   extension/             -> notify: reload it in chrome://extensions (Chrome won't let a script do it)
# Never touches a checkout with local edits or unpushed commits, and never restarts the runner mid-run.
# CI status comes from the public GitHub API, so no `gh` login is needed. Optional NTFY_TOPIC in ~/.take-the-wheel/env.
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$(dirname "$0")/.." || exit 0
LOG=~/.take-the-wheel/deploy.log STATE=~/.take-the-wheel/deploy-state REPO=vladbondarenko97/take-the-wheel
TOPIC=$(sed -n 's/^NTFY_TOPIC=//p' ~/.take-the-wheel/env 2>/dev/null | tr -d "'\"")
note() { [ -n "$TOPIC" ] && curl -s -m 10 -H "Title: take-the-wheel ($(hostname -s)): $1" -d "$2" "https://ntfy.sh/$TOPIC" >/dev/null; echo "$(date '+%F %T') $1: $2" >> "$LOG"; }
once() { [ "$(cat "$STATE" 2>/dev/null)" = "$1" ] && return 1; echo "$1" > "$STATE"; }

git fetch -q origin main 2>>"$LOG" || exit 0
here=$(git rev-parse HEAD) main=$(git rev-parse origin/main)
[ "$here" = "$main" ] && exit 0
git merge-base --is-ancestor origin/main HEAD && exit 0   # ahead: unpushed local commits, nothing to pull
if ! git merge-base --is-ancestor HEAD origin/main; then
  once "diverged $main" && note "deploy blocked" "local main and GitHub diverged; not deploying ${main:0:7}"; exit 0
fi
run=$(curl -s -m 15 "https://api.github.com/repos/$REPO/actions/runs?head_sha=$main" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const r = (JSON.parse(s).workflow_runs || []).find(r => r.name === "CI");
    console.log(r ? `${r.status} ${r.conclusion}` : "");
  });' 2>>"$LOG")
case "$run" in
  "completed success") ;;
  completed*) once "cifail $main" && note "CI failed, not deploying" "$(git log -1 --format='%h %s' origin/main)"; exit 0 ;;
  *) exit 0 ;;   # not started or still running: next minute
esac
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  once "dirty $main" && note "deploy blocked" "uncommitted changes in $(pwd); not deploying ${main:0:7}"; exit 0
fi
TOKEN=$(cat runner/.token 2>/dev/null)
curl -s -m 5 -H "Authorization: Bearer $TOKEN" localhost:19826/health | grep -q '"busy":true' && exit 0   # an agent is driving: next minute
changed=$(git diff --name-only HEAD origin/main)
git merge -q --ff-only origin/main >> "$LOG" 2>&1 || { note "deploy failed" "fast-forward to ${main:0:7} failed"; exit 0; }
done_=()
grep -qE '^package(-lock)?\.json$' <<< "$changed" && { npm install --no-audit --no-fund >> "$LOG" 2>&1 || note "npm install failed" "see $LOG"; }
if grep -qE '^(runner/|package(-lock)?\.json$)' <<< "$changed"; then
  launchctl kickstart -k "gui/$(id -u)/com.takethewheel.runner" && done_+=("runner restarted")
fi
grep -q '^extension/' <<< "$changed" && done_+=("reload the extension in chrome://extensions")
note "deployed ${main:0:7}" "$(git log -1 --format=%s HEAD)${done_:+ — $(IFS=';'; echo "${done_[*]}")}"
echo "deployed $main" > "$STATE"
