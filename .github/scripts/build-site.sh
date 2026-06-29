#!/usr/bin/env bash
# .github/scripts/build-site.sh — render the docs/ markdown + README into a small
# static site (_site/) for GitHub Pages. Pure markdown → HTML; no framework.
#
# Used by .github/workflows/pages.yml. Requires `bun` on PATH (uses `bunx marked`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

OUT="_site"
MARKED="marked@12.0.2"   # pinned markdown renderer, fetched via bunx

rm -rf "$OUT"
mkdir -p "$OUT"

# Build the nav once: home + every docs/*.md (sorted), used on every page.
nav='<a href="index.html">Home</a>'
for f in docs/*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .md)"
  nav="$nav <a href=\"${name}.html\">${name}</a>"
done

# render <title> <src.md> <out.html>
render() {
  local title="$1" src="$2" out="$3"
  {
    cat <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Polyptic</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  nav { padding: 12px 20px; border-bottom: 1px solid #8884; display: flex; flex-wrap: wrap; gap: 14px; position: sticky; top: 0; backdrop-filter: blur(8px); }
  nav a { text-decoration: none; font-weight: 600; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 20px 80px; }
  pre { background: #8881; padding: 12px 14px; border-radius: 8px; overflow: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  table { border-collapse: collapse; } th, td { border: 1px solid #8884; padding: 6px 10px; }
  img { max-width: 100%; }
</style>
</head>
<body>
<nav>${nav}</nav>
<main>
HTML
    bunx --bun "$MARKED" --gfm -i "$src"
    cat <<HTML
</main>
</body>
</html>
HTML
  } > "$out"
  echo "  rendered $src -> $out"
}

echo "==> Building static docs site into $OUT/"
# README is the landing page.
render "Polyptic" "README.md" "$OUT/index.html"
for f in docs/*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .md)"
  render "$name" "$f" "$OUT/${name}.html"
done

# Disable Jekyll so GitHub Pages serves our HTML verbatim.
touch "$OUT/.nojekyll"

echo "==> Done."
ls -1 "$OUT"
