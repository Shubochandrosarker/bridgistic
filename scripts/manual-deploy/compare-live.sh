#!/usr/bin/env bash
# compare-live.sh <dist_dir> <https://host>
# sha256 of every built file vs what the live host serves (follows redirects,
# strips Cloudflare's injected challenge <script> from HTML before hashing).
dir=$1; host=$2; same=0; diff=0
norm(){ perl -0pe 's#<script>\(function\(\)\{function c\(\).*?</script>##s'; }
while IFS= read -r f; do
  rel=${f#$dir/}; case "$rel" in _headers|_redirects|_routes.json|_worker.js*|CNAME) continue;; esac
  url="$host/$rel"; [[ $rel == index.html ]] && url="$host/"; [[ $rel == */index.html ]] && url="$host/${rel%index.html}"
  l=$(norm < "$f" | sha256sum | cut -c1-16); r=$(curl -sL --max-time 20 "$url?cmp=$RANDOM" | norm | sha256sum | cut -c1-16)
  if [[ $l == "$r" ]]; then same=$((same+1)); else diff=$((diff+1)); echo "DIFF $rel"; fi
done < <(find "$dir" -type f | sort)
echo "$host: same=$same diff=$diff"
[[ $diff -eq 0 ]]
