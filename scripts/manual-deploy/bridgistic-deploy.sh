#!/usr/bin/env bash
# bridgistic-deploy.sh — manual Bridgistic deploy that does not need GitHub Actions.
#
# Pulls a ref (default: origin/main) into a clean checkout, runs the same gates
# CI runs, builds every Cloudflare Pages project, records the live production
# deployment id of each (the rollback target), deploys with `wrangler pages
# deploy`, then smoke-tests the live hosts.
#
#   bridgistic-deploy.sh                       # gates + deploy site,dashboard,pay,console from main
#   bridgistic-deploy.sh --only dashboard,pay  # subset
#   bridgistic-deploy.sh --ref <sha|branch>    # a specific commit (production still = branch main)
#   bridgistic-deploy.sh --dry-run             # gates + builds + compare with live, no deploy
#   --strict-audit (npm audit blocks) | --skip-secrets (skip gitleaks) | --skip-gates
#   bridgistic-deploy.sh --smoke               # smoke-test live only
#   bridgistic-deploy.sh --status              # show live production deployment per project
#   bridgistic-deploy.sh --rollback <project> <deployment-id>
#   bridgistic-deploy.sh --only cloud          # MCP Worker bridgistic-cloud (apps/cloud), opt-in only
#   bridgistic-deploy.sh --rollback cloud <worker-version-id>
#
# Credentials (never printed): CLOUDFLARE_API_TOKEN (Pages:Edit) and
# CLOUDFLARE_ACCOUNT_ID from the environment, or from $BRIDGISTIC_DEPLOY_ENV
# (default /workspace/deploy/.cf.env, keys CF_PAGES_TOKEN / CF_ACCOUNT_ID).
#
# The MCP Worker `bridgistic-cloud` (apps/cloud, mcp.bridgistic.app) needs
# Workers-capable credentials: CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY (Global
# API Key) or a Workers:Edit CLOUDFLARE_API_TOKEN, read from
# $BRIDGISTIC_WORKERS_ENV (default /workspace/deploy/.cf-workers.env).
# It is never part of the default set; name it with --only cloud.
#
# Out of scope on purpose: apps/mcp, apps/api, apps/scheduler are not in
# production (see docs/DEPLOYMENT.md); their configs are dry-run validated only.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_URL=${REPO_URL:-https://github.com/Shubochandrosarker/bridgistic.git}
WORKDIR=${WORKDIR:-/workspace/deploy/bridgistic-main}
LOGDIR=${LOGDIR:-/workspace/deploy/logs}
CREDS=${BRIDGISTIC_DEPLOY_ENV:-/workspace/deploy/.cf.env}
WCREDS=${BRIDGISTIC_WORKERS_ENV:-/workspace/deploy/.cf-workers.env}
REF=main; ONLY="site,dashboard,pay,console"; MODE=deploy; STRICT_AUDIT=0; SKIP_GATES=0; SKIP_SECRETS=0

declare -A HOSTS=(
  [site]="https://bridgistic.app"
  [dashboard]="https://dashboard.bridgistic.app"
  [pay]="https://pay.bridgistic.app"
  [console]="https://admin.bridgistic.app"
)
declare -A PROJECT=( [site]=bridgistic-site [dashboard]=bridgistic-dashboard [pay]=bridgistic-pay [console]=bridgistic-console )

log(){ printf '\033[1;34m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
die(){ printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF=$2; shift 2;;
    --only) ONLY=$2; shift 2;;
    --dry-run) MODE=dry; shift;;
    --smoke) MODE=smoke; shift;;
    --status) MODE=status; shift;;
    --rollback) MODE=rollback; RB_KEY=$2; RB_ID=$3; shift 3;;
    --strict-audit) STRICT_AUDIT=1; shift;;
    --skip-gates) SKIP_GATES=1; shift;;
    --skip-secrets) SKIP_SECRETS=1; shift;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) die "unknown argument: $1";;
  esac
done

load_creds(){
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$CREDS" ]]; then
    # shellcheck disable=SC1090
    set -a; . "$CREDS"; set +a
    export CLOUDFLARE_API_TOKEN="${CF_PAGES_TOKEN:-}" CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
  fi
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "Cloudflare credentials missing (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)"
}
cf(){ curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
API(){ echo "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$1"; }
live_id(){ cf "$(API "$1")" | jq -r '.result.canonical_deployment.id // .result.latest_deployment.id'; }

status(){
  for k in ${ONLY//,/ }; do
    if [[ $k == cloud ]]; then printf 'cloud\t%s\t(worker version)\n' "$(worker_version)"; continue; fi
    cf "$(API "${PROJECT[$k]}")" | jq -r --arg k "$k" '.result.canonical_deployment as $d | [$k, $d.id, $d.created_on, ($d.deployment_trigger.metadata.commit_hash // "")[0:7], "dirty=" + ($d.deployment_trigger.metadata.commit_dirty|tostring)] | @tsv'
  done
}

smoke(){
  local fail=0 code cb
  check(){ code=$(curl -s -o /dev/null -L --max-time 25 -w '%{http_code}' "$1"); if [[ $code == "$2" ]]; then echo "  ok   $code $1"; else echo "  FAIL $code (want $2) $1"; fail=1; fi; }
  cb="smoke=$RANDOM"
  log "Smoke tests"
  for u in / /features /docs /terms /privacy /refund-policy /how-purchases-work /redeem/ /llms.txt /sitemap.xml /robots.txt; do check "https://bridgistic.app$u?$cb" 200; done
  # The repo root must never be what production serves (BR: site = site/ build only).
  for u in /package.json /README.md /apps/console/wrangler.toml; do check "https://bridgistic.app$u?$cb" 404; done
  for h in https://dashboard.bridgistic.app https://dashboard.bridgistic.app/login https://admin.bridgistic.app https://marketplace.bridgistic.app https://pay.bridgistic.app https://www.bridgistic.app; do check "$h?$cb" 200; done
  # bridgistic-cloud (MCP Worker) has no /health; OAuth metadata up + /mcp demanding auth = healthy.
  check "https://mcp.bridgistic.app/.well-known/oauth-authorization-server" 200
  check "https://mcp.bridgistic.app/mcp" 401
  # Every download link on the home page must resolve.
  while read -r dl; do check "$dl" 200; done < <(curl -s "https://bridgistic.app/?$cb" | grep -oE 'https://github.com/[^"]+/releases/download/[^"]+\.(zip|mcpb)' | sort -u)
  # No white screen: the SPA shell's entry bundle must load.
  for h in https://dashboard.bridgistic.app https://admin.bridgistic.app https://pay.bridgistic.app; do
    js=$(curl -s "$h/?$cb" | grep -oE '/assets/[^"]+\.js' | head -1)
    if [[ -n $js ]]; then check "$h$js" 200; else echo "  FAIL no entry bundle in $h/"; fail=1; fi
  done
  return $fail
}

checkout(){
  if [[ ! -d "$WORKDIR/.git" ]]; then git clone -q "$REPO_URL" "$WORKDIR"; fi
  cd "$WORKDIR"
  git fetch -q --prune origin
  if git rev-parse -q --verify "origin/$REF^{commit}" >/dev/null; then target="origin/$REF"; else target="$REF"; fi
  git checkout -q --force --detach "$target"
  git clean -q -fdx -e node_modules -e '**/node_modules'
  SHA=$(git rev-parse HEAD); SHORT=${SHA:0:7}
  log "Checked out $target = $SHORT: $(git log -1 --format=%s)"
}

gates(){
  cd "$WORKDIR"
  log "npm ci (root workspaces)"; npm ci --no-audit --no-fund >"$LOGDIR/npm-ci.log" 2>&1 || die "npm ci failed (see $LOGDIR/npm-ci.log)"
  local s
  for s in typecheck test "lint --workspace apps/dashboard" lint:sql check:placeholders check:deploy-env check:engine-pin check:tool-drift check:plugin-routes; do
    log "gate: npm run $s"; npm run $s >"$LOGDIR/gate-${s//[ \/:]/_}.log" 2>&1 || die "gate failed: $s (see $LOGDIR/gate-${s//[ \/:]/_}.log)"
  done
  log "gate: wrangler dry-run for mcp/api/scheduler x staging/production"
  local a e
  for a in mcp api scheduler; do for e in staging production; do
    CLOUDFLARE_D1_ID_STAGING=00000000-0000-0000-0000-000000000000 CLOUDFLARE_D1_ID_PRODUCTION=00000000-0000-0000-0000-000000000000 \
    CLOUDFLARE_KV_OAUTH_STAGING=00000000000000000000000000000000 CLOUDFLARE_KV_OAUTH_PRODUCTION=00000000000000000000000000000000 \
    CLOUDFLARE_API_TOKEN= npx wrangler deploy --dry-run --env $e --config apps/$a/wrangler.toml --outdir "/tmp/bridgistic-dry-$a-$e" >"$LOGDIR/dry-$a-$e.log" 2>&1 || die "wrangler dry-run failed: $a/$e"
  done; done
  if [[ $SKIP_SECRETS == 1 ]]; then log "warn: secrets gate skipped (--skip-secrets)"
  elif command -v gitleaks >/dev/null || [[ -x /workspace/tools/bin/gitleaks ]]; then
    log "gate: gitleaks (full history)"; "$(command -v gitleaks || echo /workspace/tools/bin/gitleaks)" git . --config .gitleaks.toml --no-banner --redact >"$LOGDIR/gitleaks.log" 2>&1 || die "gitleaks found something (see $LOGDIR/gitleaks.log; values are redacted)"
  else log "warn: gitleaks not installed, secrets gate skipped"; fi
  if npm audit --audit-level=high >"$LOGDIR/audit.log" 2>&1; then log "gate: npm audit clean (high/critical)"
  elif [[ $STRICT_AUDIT == 1 ]]; then die "npm audit: high/critical advisories (see $LOGDIR/audit.log)"
  else log "warn: npm audit reports high/critical advisories in dev tooling (see $LOGDIR/audit.log); pass --strict-audit to block"; fi
}

build(){
  cd "$WORKDIR"
  [[ $SKIP_GATES == 1 ]] && { log "npm ci (root)"; npm ci --no-audit --no-fund >"$LOGDIR/npm-ci.log" 2>&1; }
  if [[ ,$ONLY, == *,dashboard,* || ,$ONLY, == *,pay,* ]]; then log "build: dashboard + pay"; npm run build:frontends >"$LOGDIR/build-frontends.log" 2>&1 || die "frontend build failed"; fi
  if [[ ,$ONLY, == *,console,* ]]; then
    log "build: console (own lockfile)"; ( cd apps/console && npm ci --no-audit --no-fund && npm test && npm run typecheck:functions && npm run build ) >"$LOGDIR/build-console.log" 2>&1 || die "console build/test failed (see $LOGDIR/build-console.log)"
  fi
  if [[ ,$ONLY, == *,site,* ]]; then
    log "build: site (site/build.sh)"; rm -rf "$WORKDIR/.deploy-out/site"
    ( cd site && SITE_COMMIT=$SHORT bash build.sh "$WORKDIR/.deploy-out/site" ) >"$LOGDIR/build-site.log" 2>&1 || die "site build failed"
    git checkout -q -- site   # build-seo.mjs also rewrites source files; keep the checkout clean
  fi
}

dist_of(){ case $1 in site) echo "$WORKDIR/.deploy-out/site";; *) echo "$WORKDIR/apps/$1/dist";; esac; }
dir_of(){ case $1 in site) echo "$WORKDIR/site";; *) echo "$WORKDIR/apps/$1";; esac; }

deploy_one(){
  local k=$1 p=${PROJECT[$1]} before after
  before=$(live_id "$p")
  echo "$(date '+%F %T %Z') $p before=$before commit=$SHORT" >>"$LOGDIR/rollback-ledger.txt"
  log "deploy $p (rollback target: $before)"
  local W="$WORKDIR/node_modules/.bin/wrangler"; [[ $k == console ]] && W="$WORKDIR/apps/console/node_modules/.bin/wrangler"
  ( cd "$(dir_of "$k")" && "$W" pages deploy "$(dist_of "$k")" --project-name "$p" --branch main \
      --commit-hash "$SHA" --commit-message "manual deploy $SHORT (no GitHub Actions)" --commit-dirty=false ) >"$LOGDIR/deploy-$k.log" 2>&1 \
    || { tail -20 "$LOGDIR/deploy-$k.log"; die "deploy failed: $p (live is unchanged: $before)"; }
  after=$(live_id "$p")
  echo "$(date '+%F %T %Z') $p after=$after commit=$SHORT" >>"$LOGDIR/rollback-ledger.txt"
  log "  $p live: $after   rollback: $0 --rollback $k $before"
}

# Run wrangler for the Worker with Workers credentials only (never the Pages token).
wr(){ ( set -a; [[ -f "$WCREDS" ]] && . "$WCREDS"; set +a
        [[ -n "${CLOUDFLARE_API_KEY:-}" ]] && unset CLOUDFLARE_API_TOKEN
        cd "$WORKDIR/apps/cloud" && ./node_modules/.bin/wrangler "$@" ); }
worker_version(){ wr deployments status --json 2>/dev/null | jq -r '.versions[0].version_id'; }

build_cloud(){
  [[ -d "$WORKDIR/apps/cloud" ]] || die "apps/cloud is not in $SHORT"
  log "build: cloud Worker (own lockfile): npm ci, typecheck, tests, audit, dry-run"
  ( cd "$WORKDIR/apps/cloud" && npm ci --no-audit --no-fund && npm run typecheck && npm test ) >"$LOGDIR/build-cloud.log" 2>&1 || die "cloud build/test failed (see $LOGDIR/build-cloud.log)"
  ( cd "$WORKDIR/apps/cloud" && npm audit --audit-level=high ) >"$LOGDIR/audit-cloud.log" 2>&1 || { [[ $STRICT_AUDIT == 1 ]] && die "cloud npm audit (see $LOGDIR/audit-cloud.log)"; log "warn: cloud npm audit has high/critical advisories"; }
  wr deploy --dry-run --outdir "/tmp/bridgistic-cloud-dry" >"$LOGDIR/dry-cloud.log" 2>&1 || die "cloud wrangler dry-run failed (see $LOGDIR/dry-cloud.log)"
}

deploy_cloud(){
  local before after
  before=$(worker_version); [[ -n $before && $before != null ]] || die "could not read the live bridgistic-cloud version (Workers credentials?)"
  echo "$(date '+%F %T %Z') bridgistic-cloud before=$before commit=$SHORT" >>"$LOGDIR/rollback-ledger.txt"
  log "deploy bridgistic-cloud Worker (rollback target version: $before)"
  wr deploy --message "manual deploy $SHORT (no GitHub Actions)" >"$LOGDIR/deploy-cloud.log" 2>&1 || { tail -20 "$LOGDIR/deploy-cloud.log"; die "Worker deploy failed (live unchanged: $before)"; }
  after=$(worker_version)
  echo "$(date '+%F %T %Z') bridgistic-cloud after=$after commit=$SHORT" >>"$LOGDIR/rollback-ledger.txt"
  log "  bridgistic-cloud live version: $after   rollback: $0 --rollback cloud $before"
}

rollback(){
  if [[ $RB_KEY == cloud ]]; then
    local before; before=$(worker_version)
    wr rollback "$RB_ID" --message "rollback via bridgistic-deploy.sh" -y
    echo "$(date '+%F %T %Z') bridgistic-cloud ROLLBACK from=$before to=$RB_ID" >>"$LOGDIR/rollback-ledger.txt"; return
  fi
  local p=${PROJECT[$RB_KEY]:-}; [[ -n $p ]] || die "unknown project key $RB_KEY (site|dashboard|pay|console)"
  local before; before=$(live_id "$p")
  cf -X POST "$(API "$p")/deployments/$RB_ID/rollback" | jq -r '"rolled back: " + .result.id + " (" + .result.environment + ")"'
  echo "$(date '+%F %T %Z') $p ROLLBACK from=$before to=$RB_ID" >>"$LOGDIR/rollback-ledger.txt"
}

mkdir -p "$LOGDIR"
case $MODE in
  smoke) smoke; exit $?;;
  status) load_creds; status; exit 0;;
  rollback) [[ $RB_KEY == cloud ]] || load_creds; rollback; exit 0;;
esac
load_creds
checkout
[[ $SKIP_GATES == 1 ]] || gates
build
[[ ,$ONLY, == *,cloud,* ]] && build_cloud
if [[ $MODE == dry ]]; then
  for k in ${ONLY//,/ }; do [[ $k == cloud ]] && continue; "$SCRIPT_DIR/compare-live.sh" "$(dist_of "$k")" "${HOSTS[$k]}" || true; done
  log "dry run: nothing deployed"; exit 0
fi
for k in ${ONLY//,/ }; do if [[ $k == cloud ]]; then deploy_cloud; else deploy_one "$k"; fi; done
sleep 5
smoke && log "Deployed $SHORT and smoke tests passed." || die "smoke tests failed after deploy — see above; roll back with --rollback (ids in $LOGDIR/rollback-ledger.txt)"
