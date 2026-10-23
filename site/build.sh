#!/usr/bin/env bash
# Build the bridgistic.app marketing site into dist/.
#
# The site source lives in the app repository (Shubochandrosarker/bridgistic);
# the WordPress plugin repositories carry only plugin code. Run from site/:
#
#   ./build.sh [out-dir]        (default: dist)
#
# Requires: gh (authenticated), sed, node. Placeholder tokens in index.html
# are filled from the newest published plugin release; crawl files are
# regenerated from the live pages so a content edit cannot ship stale SEO.
set -euo pipefail

OUT="${1:-dist}"
TAG="${BRIDGISTIC_RELEASE_TAG:-$(gh api repos/Wordpressistic/bridgistic/releases/latest --jq .tag_name)}"
VERSION="${TAG#v}"
DOWNLOAD="https://github.com/Wordpressistic/bridgistic/releases/download/$TAG"
PAGE="https://github.com/Wordpressistic/bridgistic/releases/tag/$TAG"
REPO="Wordpressistic/bridgistic"
COMMIT="${SITE_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
PADDLE_CLIENT_TOKEN="${PADDLE_CLIENT_TOKEN:-}"
PADDLE_ENV="${PADDLE_ENV:-production}"
OFFER_STATUS_URL="${OFFER_STATUS_URL:-/api/offer-status}"

echo "Building site with Bridgistic $TAG"

rm -rf "$OUT"
mkdir -p "$OUT/assets"

sed -e "s#__BRIDGISTIC_RELEASE_VERSION__#$VERSION#g" \
    -e "s#__BRIDGISTIC_RELEASE_DOWNLOAD__#$DOWNLOAD#g" \
    -e "s#__BRIDGISTIC_RELEASE_PAGE__#$PAGE#g" \
    -e "s#__BRIDGISTIC_RELEASE_REPO__#$REPO#g" \
    -e "s#__BRIDGISTIC_SITE_COMMIT__#$COMMIT#g" \
    -e "s#__BRIDGISTIC_PADDLE_CLIENT_TOKEN__#$PADDLE_CLIENT_TOKEN#g" \
    -e "s#__BRIDGISTIC_PADDLE_ENV__#$PADDLE_ENV#g" \
    -e "s#__BRIDGISTIC_OFFER_STATUS_URL__#$OFFER_STATUS_URL#g" \
    index.html > "$OUT/index.html"

if grep -Eq '__BRIDGISTIC_[A-Z_]+__' "$OUT/index.html"; then
  echo "A site build marker was not replaced" >&2
  exit 1
fi

printf 'bridgistic.app\n' > "$OUT/CNAME"
cp assets/* "$OUT/assets/"
cp terms.html privacy.html refund-policy.html how-purchases-work.html features.html docs.html "$OUT/"

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
- Console: https://admin.bridgistic.app/ — account dashboard and platform admin (sites, keys, approvals, licenses, AI routing).
EOF
  cat >> "$OUT/llms-full.txt" <<'EOF'

## Skills marketplace (as of 2026-10-23)
- Public directory: https://marketplace.bridgistic.app/ — 100 free skills under @wordpressistic, browsable without an account.
- Install: bridgistic skills install @wordpressistic/{slug} or npx skills add https://marketplace.bridgistic.app/wordpressistic/{slug}.
- Pro collection: 30 production skills exclusive to Bridgistic Pro license holders (agent ops, market intelligence, documents, research automation).
- Console: https://admin.bridgistic.app/ (account dashboard + platform admin). Sessions are shared across dashboard., admin. and marketplace. subdomains.
EOF
}
append_marketplace

echo "Site built into $OUT"
