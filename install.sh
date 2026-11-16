#!/usr/bin/env bash
# gh-forge installer — gets `gh forge` working, installing prerequisites as needed.
#
#   curl -fsSL https://raw.githubusercontent.com/mekarpeles/gh-forge/main/install.sh | bash
#   # or, from a clone:
#   ./install.sh
#
# Installs (where missing): git, node (>=18), gh, the `gh webhook` extension (the
# forwarder transport), and the `gh-forge` extension itself. Auto-installs via
# Homebrew or apt when available; otherwise points you at the official installer.
set -euo pipefail

REPO="mekarpeles/gh-forge"

blue() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

PM=""
if have brew; then PM=brew
elif have apt-get; then PM=apt
fi

ensure() { # ensure <cmd> <brew-pkg> <apt-pkgs> <url>
  local cmd=$1 brewp=$2 aptp=$3 url=$4
  have "$cmd" && return 0
  blue "installing $cmd"
  case "$PM" in
    brew) brew install "$brewp" ;;
    apt)  sudo apt-get update -y && sudo apt-get install -y $aptp ;;
    *)    fail "$cmd is required — install it from $url and re-run" ;;
  esac
  have "$cmd" || fail "$cmd still not found after install — see $url"
}

# 1. prerequisites
ensure git  git  git          "https://git-scm.com"
ensure node node "nodejs npm" "https://nodejs.org"
ensure gh   gh   gh           "https://cli.github.com"

nodev=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$nodev" -ge 18 ] || fail "node >= 18 required (found $(node -v 2>/dev/null)) — update at https://nodejs.org"

# 2. GitHub auth
if ! gh auth status >/dev/null 2>&1; then
  blue "authenticating gh (needs admin:repo_hook scope for webhook forwarding)"
  gh auth login
fi

# 3. the gh webhook extension (powers `gh webhook forward`, the furnace forwarder)
if ! gh extension list 2>/dev/null | grep -q 'cli/gh-webhook'; then
  blue "installing the gh webhook extension"
  gh extension install cli/gh-webhook
fi

# 4. gh-forge itself (-> `gh forge`)
if gh extension list 2>/dev/null | grep -q '/gh-forge'; then
  blue "upgrading gh-forge"; gh extension upgrade gh-forge || true
else
  blue "installing gh-forge"; gh extension install "$REPO"
fi

# 5. verify
gh forge >/dev/null 2>&1 || fail "'gh forge' did not install correctly"
blue "gh forge is ready."
cat <<'EOF'

Next — point it at a project (a "furnace": a dir with forge.yml + jobs/ + .env):
  gh forge add <name> <path>    # register it
  gh forge up  <name>           # start it (engine + scheduler + forwarder, supervised)
  gh forge ls                   # furnaces + status   ·   gh forge status   ·   gh forge logs <name>
EOF
