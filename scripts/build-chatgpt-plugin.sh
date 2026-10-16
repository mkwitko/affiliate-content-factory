#!/usr/bin/env bash
# Packages the ChatGPT plugin zip for "Upload new version" on the existing developer-mode plugin.
# The name and app id come from ChatGPT's "Download plugin zip" and must not change.
# Usage: scripts/build-chatgpt-plugin.sh <version> [output.zip]
#   CHATGPT_APP_ZIP=~/Downloads/dev-<id>.zip scripts/build-chatgpt-plugin.sh <version>
#   takes the name and app id from a freshly downloaded zip (after recreating the app).
set -euo pipefail
version="${1:?usage: $0 <version> [output.zip]}"
name="dev-6ab45ac4bbd88191a7d10e1391d25495"
app_id="asdk_app_6ab45ac4bbd88191a7d10e1391d25495"
if [ -n "${CHATGPT_APP_ZIP:-}" ]; then
  app_json="$(unzip -p "$CHATGPT_APP_ZIP" .app.json)"
  name="$(printf '%s' "$app_json" | sed -n 's/^ *"\(dev-[0-9a-f]*\)": {.*/\1/p' | head -1)"
  app_id="$(printf '%s' "$app_json" | sed -n 's/^ *"id": "\(asdk_app_[0-9a-f]*\)".*/\1/p' | head -1)"
  [ -n "$name" ] && [ -n "$app_id" ] || { echo "no app name/id in $CHATGPT_APP_ZIP" >&2; exit 1; }
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(realpath -m "${2:-$root/money-maker-plugin-$version.zip}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/.codex-plugin" "$work/skills"
cp -r "$root"/apps/api/src/mcp/skills/*/ "$work/skills/"
cat > "$work/.app.json" <<JSON
{
  "apps": {
    "$name": {
      "id": "$app_id"
    }
  }
}
JSON
cat > "$work/.codex-plugin/plugin.json" <<JSON
{
  "apps": "./.app.json",
  "skills": "./skills/",
  "author": {
    "name": "Money Maker"
  },
  "description": "Research Mercado Livre products, write evidenced copy, build creatives, and publish after approval.",
  "interface": {
    "capabilities": ["Read", "Write"],
    "category": "Productivity",
    "defaultPrompt": null,
    "developerName": "Money Maker",
    "displayName": "MoneyMaker",
    "longDescription": "Research Mercado Livre products, read buyer voice and official photos, write evidenced copy, build creatives, preview, and publish only after approval.",
    "shortDescription": "Evidenced affiliate content from research to approved publication"
  },
  "name": "$name",
  "version": "$version"
}
JSON
rm -f "$out"
(cd "$work" && zip -qr "$out" .app.json .codex-plugin skills)
echo "$out"
