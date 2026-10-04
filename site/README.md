# yolobridge.sh

The site behind `curl -fsSL https://yolobridge.sh | sh`: a YOLO Host Worker that
serves the installer to terminals and a landing page to browsers. It mirrors
`yolostart-sh` (same negotiation, palette and octopus), minus release assets:
yolo-bridge itself ships through npm as `@yolo-labs/yolobridge`.

## What it serves

| Request | Response |
|---|---|
| `GET /` from a browser (`Sec-Fetch-Dest: document` or `Accept: text/html`) | `landing.html`, with the installer banner embedded |
| `GET /` from anything else (curl, wget) | `install.sh`, byte for byte |
| `GET /install.sh`, `GET /?raw` | `install.sh`, even in a browser |
| `GET /` from a link-preview or search crawler (Slackbot, Twitterbot, ...) | `landing.html`, for its og:/twitter: tags |
| `/favicon.ico`, `/apple-touch-icon.png`, `/og.png` | icons and the 1200×630 social card |

The only User-Agent rule is that crawler allow-list (`isPreviewBot`); curl and
wget never match it. Every response is `Cache-Control: no-store` with
`Vary: Accept, Sec-Fetch-Dest, User-Agent`. Regenerate the social card with
`python3 scripts/site-og-cards.py` (monorepo root; needs Pillow).

## The installer

`install.sh` is POSIX sh. It checks for Node.js 20+ and npm, then runs
`npm install --global @yolo-labs/yolobridge@${YOLOBRIDGE_VERSION:-latest}`. It
never installs a runtime and never uses sudo: when npm's global prefix is
root-owned it explains the alternatives and stops.

## Develop

```sh
npm run build   # dist/worker.mjs (+ empty dist/assets/)
npm test        # installer (stubbed node/npm) + worker routing tests
dash -n install.sh && shellcheck -s sh install.sh
```

Deployed with `yolo deploy` (see `.yolo/deploy.json`), with the custom domain
`yolobridge.sh` connected to the project.
