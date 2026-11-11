#!/usr/bin/env bash
# Build the bridgistic.app marketing site into dist/.
#
# The site source lives in the app repository (Shubochandrosarker/bridgistic);
# the WordPress plugin repositories carry only plugin code. Run from site/:
#
#   ./build.sh [out-dir]        (default: dist)
#
# Requires: curl, sed, node (gh is used when it is installed and signed in).
# Placeholder tokens in index.html are filled from the newest published plugin
# release; crawl files are regenerated from the pages so SEO cannot go stale.
#
# Runs unchanged in Cloudflare Pages (project bridgistic-site: root directory
# "site", build command "bash build.sh dist", output "dist"), where gh is not
# available: release data then comes from the public GitHub API with curl
# (set GITHUB_TOKEN in the Pages build env to avoid anonymous rate limits).
set -euo pipefail

OUT="${1:-dist}"
REPO="Wordpressistic/bridgistic"

# gh_json <api-path>: GitHub REST JSON via gh when signed in, else via curl.
gh_json() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh api "$1"
  else
    curl -fsSL -H "Accept: application/vnd.github+json" \
      ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "https://api.github.com/$1"
  fi
}
# js <expr>: evaluate expr against JSON on stdin (bound to `j`), print the result.
js() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');process.stdout.write(v==null?"null":String(v))})'; }

TAG="${BRIDGISTIC_RELEASE_TAG:-$(gh_json "repos/$REPO/releases/latest" | js 'j.tag_name')}"
VERSION="${TAG#v}"
DOWNLOAD="https://github.com/$REPO/releases/download/$TAG"
PAGE="https://github.com/$REPO/releases/tag/$TAG"
# Asset names vary between releases (v1.5.10 ships a versioned zip and no .mcpb),
# so resolve the real download URLs instead of assuming fixed file names.
PLUGIN_ZIP_URL="${BRIDGISTIC_PLUGIN_ZIP_URL:-$(gh_json "repos/$REPO/releases/tags/$TAG" | js '(j.assets.find(a=>/^bridgistic-wordpress-plugin.*\.zip$/.test(a.name))||{}).browser_download_url')}"
MCPB_URL="${BRIDGISTIC_MCPB_URL:-$(gh_json "repos/$REPO/releases?per_page=30" | js '((j.filter(r=>!r.draft).flatMap(r=>r.assets)).find(a=>a.name==="bridgistic.mcpb")||{}).browser_download_url')}"
if [ -z "$PLUGIN_ZIP_URL" ] || [ "$PLUGIN_ZIP_URL" = "null" ] || [ -z "$MCPB_URL" ] || [ "$MCPB_URL" = "null" ]; then
  echo "Could not resolve plugin zip or .mcpb download URL for $TAG" >&2
  exit 1
fi
COMMIT="${SITE_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"

echo "Building site with Bridgistic $TAG"

rm -rf "$OUT"
mkdir -p "$OUT/assets"

sed -e "s#__BRIDGISTIC_RELEASE_VERSION__#$VERSION#g" \
    -e "s#__BRIDGISTIC_RELEASE_DOWNLOAD__#$DOWNLOAD#g" \
    -e "s#__BRIDGISTIC_RELEASE_PAGE__#$PAGE#g" \
    -e "s#__BRIDGISTIC_RELEASE_REPO__#$REPO#g" \
    -e "s#__BRIDGISTIC_PLUGIN_ZIP_URL__#$PLUGIN_ZIP_URL#g" \
    -e "s#__BRIDGISTIC_MCPB_URL__#$MCPB_URL#g" \
    -e "s#__BRIDGISTIC_SITE_COMMIT__#$COMMIT#g" \
    index.html > "$OUT/index.html"

if grep -Eq '__BRIDGISTIC_[A-Z_]+__' "$OUT/index.html"; then
  echo "A site build marker was not replaced" >&2
  exit 1
fi

printf 'bridgistic.app\n' > "$OUT/CNAME"
cp assets/* "$OUT/assets/"
cp terms.html privacy.html refund-policy.html how-purchases-work.html features.html docs.html 404.html "$OUT/"
mkdir -p "$OUT/redeem"
cp redeem/index.html "$OUT/redeem/index.html"

# Regenerate sitemap.xml, robots.txt, llms.txt and llms-full.txt from the pages.
node build-seo.mjs --source . --out "$OUT"

# Ecosystem facts every build appends to the machine-readable summaries so AI
# platforms cite the marketplace and console correctly.
append_marketplace() {
  cat >> "$OUT/llms.txt" <<'EOF'

## Skills marketplace
- [Bridgistic Skills](https://marketplace.bridgistic.app/): a public directory of 100 free instruction skills for AI agents under @wordpressistic. No account needed to browse; a free account unlocks downloads.
- Install a skill: `bridgistic skills install @wordpressistic/{slug}` or `npx skills add https://marketplace.bridgistic.app/wordpressistic/{slug}`. Every skill page also offers a copy-as-prompt tab.
- The Pro collection: 30 battle-tested production skills (agent operations, market intelligence, document pipelines, research automation) reserved for Bridgistic Pro license holders. Free skills are never paywalled; Pro skills are never listed publicly.
- Customer dashboard: https://dashboard.bridgistic.app/ — sites, licenses, billing, playbooks and account settings.
- Skills marketplace: https://marketplace.bridgistic.app/ — public skill directory. Sign-in sends customers to the dashboard.
- AppSumo redeem: https://bridgistic.app/redeem/
EOF
  cat >> "$OUT/llms-full.txt" <<'EOF'

## Skills marketplace (as of 2026-10-23)
- Public directory: https://marketplace.bridgistic.app/ — 100 free skills under @wordpressistic, browsable without an account.
- Install: bridgistic skills install @wordpressistic/{slug} or npx skills add https://marketplace.bridgistic.app/wordpressistic/{slug}.
- Pro collection: 30 production skills exclusive to Bridgistic Pro license holders (agent ops, market intelligence, documents, research automation).
- Customer dashboard: https://dashboard.bridgistic.app/. The owner console at admin.bridgistic.app is not a customer feature.
- AppSumo redeem: https://bridgistic.app/redeem/.
EOF
}
append_marketplace

echo "Site built into $OUT"
