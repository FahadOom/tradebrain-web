#!/data/data/com.termux/files/usr/bin/bash
# Creates a NEW repo (your TradeBrain app repo is not touched), pushes this folder, enables GitHub Pages.
cd "$(dirname "$0")" || exit 1
command -v git >/dev/null || pkg install -y git
command -v curl >/dev/null || pkg install -y curl
read -r -p "GitHub username [FahadOom]: " U; U=${U:-FahadOom}
read -r -p "New repo name [tradebrain-web]: " R; R=${R:-tradebrain-web}
read -r -s -p "GitHub token (needs repo + workflow): " T; echo
export TB_TOKEN="$T"; ASK=$(mktemp); printf '#!/bin/sh\necho "$TB_TOKEN"\n' > "$ASK"; chmod +x "$ASK"
export GIT_ASKPASS="$ASK" GIT_TERMINAL_PROMPT=0
H=(-H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json")
curl -s -o /dev/null -w "create repo: HTTP %{http_code} (201 = created, 422 = already exists)\n" "${H[@]}" -X POST https://api.github.com/user/repos -d "{\"name\":\"$R\",\"private\":false,\"description\":\"TradeBrain web: scanner, Traders Council, guarded execution\"}"
[ -d .git ] || git init -q
git checkout -q -B main
git config user.name "$U"; git config user.email "$U@users.noreply.github.com"
git add -A; git commit -q -m "TradeBrain web" || true
git push -f "https://$U@github.com/$U/$R.git" main || { echo "PUSH FAILED: check the token has repo + workflow permission"; rm -f "$ASK"; exit 1; }
curl -s -o /dev/null -w "enable pages: HTTP %{http_code}\n" "${H[@]}" -X POST "https://api.github.com/repos/$U/$R/pages" -d '{"build_type":"workflow"}'
curl -s -o /dev/null -w "start deploy: HTTP %{http_code}\n" "${H[@]}" -X POST "https://api.github.com/repos/$U/$R/actions/workflows/pages.yml/dispatches" -d '{"ref":"main"}'
curl -s -o /dev/null -w "start apk build: HTTP %{http_code}\n" "${H[@]}" -X POST "https://api.github.com/repos/$U/$R/actions/workflows/android.yml/dispatches" -d '{"ref":"main"}'
rm -f "$ASK"
echo; echo "Done. Check progress: https://github.com/$U/$R/actions"
echo "APK (ready in ~5-8 min): https://github.com/$U/$R/releases"
echo "Web app link (live in ~1-2 min): https://$U.github.io/$R/"
