#!/usr/bin/env bash
# Local-only check of developer AI tooling. Not used by API, worker, or CI.
# Reports presence only; never prints tokens or config values.
set -u
cd "$(dirname "$0")/.."

row() { printf '%-16s %s\n' "$1" "$2"; }
has() { command -v "$1" >/dev/null 2>&1; }

row "Node" "$(has node && node -v || echo MISSING)"
row "pnpm" "$(has pnpm && pnpm -v || echo MISSING)"

if has codegraph; then
  if [ -f .codegraph/codegraph.db ]; then
    row "CodeGraph" "OK $(codegraph --version) (index present)"
  else
    row "CodeGraph" "INSTALLED $(codegraph --version), run: codegraph init"
  fi
else
  row "CodeGraph" "MISSING (npm i -g @colbymchenry/codegraph@1.6.1)"
fi

if grep -q '"context-mode@context-mode": true' .claude/settings.local.json 2>/dev/null; then
  row "Context Mode" "TRIAL (Claude Code, local scope)"
else
  row "Context Mode" "not enabled here (optional trial)"
fi

for s in retro wizard; do
  [ -f "$HOME/.claude/skills/$s/SKILL.md" ] && row "skill:$s" "OK" || row "skill:$s" "missing (optional)"
done

row "Claude Code" "$(has claude && claude --version 2>/dev/null | head -1 || echo MISSING)"
row "Codex" "$(has codex && codex --version 2>/dev/null | head -1 || echo MISSING)"
