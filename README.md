# yolo-bridge

Attach the coding agent on your own machine — Claude Code, Codex, or another terminal agent — to a [YOLO Studio](https://yolo.studio) workspace as a first-class tile.

`yolo-bridge` is a small local daemon. It runs your agent in a real terminal on your machine. You keep driving that session yourself, and prompts sent from the workspace land in the same session. The agent's screen streams back to the tile, and the agent gets the same workspace-wide YOLO Studio tools a cloud-hosted agent tile has.

```sh
npm install -g @yolo-labs/yolobridge

yolo-bridge login          # one-time device-authorization sign-in
yolo-bridge attach         # pick a workspace; spawns `claude` and attaches it
```

Requires Node.js 20+.

## How it works

- **Your agent, your machine.** `attach` spawns your agent in a pseudo-terminal (`node-pty`) and mirrors it into a headless terminal model (`@xterm/headless`). Your own terminal stays connected to that session, so local typing and remote prompts go to the same process. It is not a separate shadow copy.
- **Outbound connections only.** The daemon makes one outbound connection to YOLO Studio and holds it open for events. It sends a heartbeat every ~10s and reconnects with backoff after sleep or network loss. Nothing connects in to your machine.
- **Workspace tools via a local MCP proxy.** On attach the daemon starts an MCP proxy bound to `127.0.0.1`. It mints short-lived, scoped tokens on demand and configures the agent to use them. Claude Code and Codex are wired automatically. Other agents still run, just without the workspace tools.
- **Files only move when you push them.** `share` uploads a file you name. The cloud cannot ask the daemon to read a path. The attached agent can send files only from paths you have approved with `allow`. That approval list prevents accidents and is visible in `status`. It is not a security boundary: the agent runs as your OS user and has a shell.

## Commands

| Command | What it does |
|---|---|
| `login` | Sign in with the device-authorization flow. |
| `workspaces` | List the workspaces you can attach to. |
| `attach [workspace]` | Attach this machine to a workspace (by id or name; omit it to pick interactively) and run the daemon loop. |
| `detach` | End the current attachment. |
| `allow <path>` | Approve a path the attached agent may send files from. Also `--list` and `--remove <path>`. |
| `share <path> [--to <tileId>]` | Upload a local file to the workspace. `--to` also places it in that tile's session. |
| `deliver <assetId> --to <tileId>` | Place an already-shared file into a tile's session without uploading it again. |
| `status` | Show local login, attachment and approved paths. |
| `version` | Print the installed version. |

### `attach` options

| Flag | Meaning |
|---|---|
| `--agent <binary>` | Agent to spawn. Default: `$YOLOBRIDGE_AGENT_BIN`, else `claude`. |
| `--agent-id <id>` | The agent's registry id, used for MCP wiring when it differs from the binary name (e.g. `--agent /opt/bin/claude --agent-id claude`). |
| `--label <name>` | Host label shown in the workspace. Defaults to this machine's hostname. |
| `--fresh` | Always create a new attachment and tile, instead of resuming a live one for this workspace. |

## Configuration

| Variable | Default |
|---|---|
| `YOLOBRIDGE_AGENT_BIN` | `claude` |
| `YOLOBRIDGE_API_URL` | `https://api.yolo.studio` |
| `YOLOBRIDGE_AUTH_URL` | `https://auth.yololabs.ai` |
| `YOLOBRIDGE_MCP_URL` | `https://services.yolo.studio` |

Credentials, the current attachment and approved paths are stored under `~/.config/yolobridge/`.

## Troubleshooting

**`failed to start the local agent (posix_spawnp failed.)` on macOS.** This usually means `node-pty` could not run its own `spawn-helper`; your agent itself is probably fine. Common causes are a lost executable bit after `npm install`, Gatekeeper quarantine on a downloaded prebuild, or a partially restored `node_modules`. `attach` checks for this and reports the helper path it found. Reinstalling the package usually fixes it.

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm test        # build, then node --test dist/*.test.js
```

## Source & contributing

[github.com/yolo-labs-hq/yolobridge](https://github.com/yolo-labs-hq/yolobridge) is a public mirror of `yolobridge/` in YOLO Labs' private monorepo, which stays the source of truth. The mirror is synced automatically on every change. Issues are welcome. Pull requests are welcome too: we apply them in the monorepo, keeping you as the author, and the change then syncs back here.

## License

MIT. See [LICENSE](./LICENSE).
