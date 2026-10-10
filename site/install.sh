#!/bin/sh
# POSIX installer for yolo-bridge. ASCII mark adapted from the YOLO octopus brand asset.
set -eu
if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then printf '\033[32m'; fi
cat <<'BANNER'
+------------------------------------------------------------------------------+
|          ######          YOLO STUDIO  /  YOUR AGENT, YOUR WORKSPACE          |
|        ##########                                                            |
|       ##   ##   ##                      __      __         _     __          |
|       ##   ##   ##         __  ______  / /___  / /_  _____(_)___/ /___ ____  |
|       ############        / / / / __ \/ / __ \/ __ \/ ___/ / __  / __ `/ _ \ |
| ######################## / /_/ / /_/ / / /_/ / /_/ / /  / / /_/ / /_/ /  __/ |
|  ######## #### #######   \__, /\____/_/\____/_.___/_/  /_/\__,_/\__, /\___/  |
|    ###  #### ###  ###   /____/                                 /____/        |
|    #     ######     #                                                        |
|    #     ## ####    #    YOUR AGENT JOINS THE WORKSPACE.                     |
|    ###   ##   ##  ###                                                        |
|      ##  #   ##  ##      Claude Code or Codex, running right here,           |
|         ## ###           as a tile in your YOLO Studio workspace.            |
|         ##                                                                   |
|          ###                                                                 |
|                                                                              |
| THREE STEPS                                                                  |
|   1. This script installs yolo-bridge with npm. Node 20+, no sudo.           |
|   2. yolo-bridge login      Sign in through the browser link.                |
|   3. yolo-bridge attach     Pick a workspace. Your agent joins as a tile.    |
|                                                                              |
| MAKE IT YOURS                                                                |
|   --agent codex        Attach Codex instead of Claude Code.                  |
|   --label laptop       Name this machine in the workspace.                   |
|   YOLOBRIDGE_VERSION   Pin a release instead of using latest.                |
|                                                                              |
| YOUR MACHINE, YOUR CALL                                                      |
|   Nothing connects in. The daemon dials out and holds one stream.            |
|   The bridge sends files only when you share them, or when your agent        |
|   does from paths you allow. Your agent still runs as you.                   |
|                                                                              |
| PREFER NPM?  /  SAME PACKAGE                                                 |
|   npm install -g @yolo-labs/yolobridge                                       |
|   Explore YOLO Studio: https://yolo.studio                                   |
|   Read this script before running it. The code starts below.                 |
+------------------------------------------------------------------------------+
BANNER
if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then printf '\033[0m'; fi
printf '\n'

fail() { printf 'yolo-bridge: %s\n' "$*" >&2; exit 1; }
case "$(uname -s)" in
    Linux|Darwin) ;;
    *) fail 'Supported platforms: macOS and Linux (on Windows, run it inside WSL).' ;;
esac

# yolo-bridge is a Node CLI: it spawns your agent in a real terminal (node-pty).
# This script checks for Node; it never installs a runtime or runs sudo.
command -v node >/dev/null 2>&1 \
    || fail 'yolo-bridge needs Node.js 20 or newer. Install it from https://nodejs.org (or with brew, nvm, fnm or volta), then re-run.'
command -v npm >/dev/null 2>&1 || fail 'Node.js is installed but npm is not on your PATH. Install npm, then re-run.'
node_version=$(node -p 'process.versions.node' 2>/dev/null) || fail 'Could not run node.'
case "${node_version%%.*}" in ''|*[!0-9]*) fail "Could not read the Node.js version ($node_version)." ;; esac
[ "${node_version%%.*}" -ge 20 ] || fail "Node.js $node_version found; yolo-bridge needs 20 or newer."

version=${YOLOBRIDGE_VERSION:-latest}
case "$version" in ''|.*|-*|*[!a-zA-Z0-9.-]*) fail 'Invalid YOLOBRIDGE_VERSION.' ;; esac

# A global install writes to npm's prefix. When that is root-owned (a system
# Node), say so instead of reaching for sudo. npm creates missing folders, so
# judge each target by its nearest existing ancestor (a fresh prefix has none).
prefix=$(npm prefix -g 2>/dev/null) || fail 'Could not read npm'"'"'s global prefix.'
writable() {
    target=$1
    while [ ! -e "$target" ]; do target=$(dirname "$target"); done
    [ -w "$target" ]
}
if ! writable "$prefix/lib/node_modules" || ! writable "$prefix/bin"; then
    fail "npm installs global packages into $prefix, which needs sudo. This script won't use sudo.
  Use a Node version manager (nvm, fnm or volta), or point npm at a folder you own:
    npm config set prefix \"\$HOME/.npm-global\"
    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"
  then re-run."
fi

printf 'Installing @yolo-labs/yolobridge@%s with npm (Node %s)...\n' "$version" "$node_version" >&2
npm install --global --no-fund --no-audit "@yolo-labs/yolobridge@$version" >&2 \
    || fail 'npm install failed; see the output above.'

if command -v yolo-bridge >/dev/null 2>&1; then
    printf '\nInstalled yolo-bridge %s.\n' "$(yolo-bridge version 2>/dev/null || echo '')"
else
    printf '\nInstalled, but %s/bin is not on your PATH. Add it, then open a new terminal.\n' "$prefix"
fi
cat <<'NEXT'

Next:
  yolo-bridge login      Sign in through the browser link it prints.
  yolo-bridge attach     Pick a workspace; your agent joins it as a tile.
  yolo-bridge --help     Everything else.
NEXT
