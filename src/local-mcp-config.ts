/**
 * Writes/removes a PROJECT-scoped `.mcp.json` entry for the local MCP proxy
 * (mcp-proxy.ts) in the `yolo-bridge attach` spawn `cwd`.
 *
 * Deliberately NOT the user's global `~/.claude.json` — that's what
 * `containers/services/container-api/mcp-config-writer.js` writes to
 * in-pod, which is fine there because a pod is single-purpose and thrown
 * away. A laptop is not: writing into the global config would leak a
 * workspace-scoped MCP server into every unrelated Claude Code session the
 * user runs on their own machine. `.mcp.json` in the attach directory is
 * scoped to exactly that directory.
 *
 * Preserves any pre-existing `.mcp.json` content the same way the pod-side
 * writer's own header comment describes ("preserves user-added entries") —
 * adapted to a single project file rather than a global merge: only the key
 * this module owns (`SERVER_NAME`) is ever added or removed; every other
 * key in the file is left untouched.
 *
 * Refuses to write anything if `.mcp.json` is confirmed NOT git-ignored
 * inside a real repo at `cwd` (Codex review, 2026-08-24, round 16 — this
 * repo's OWN root tracks `.mcp.json`, verified with `git cat-file`, not
 * assumed): round 12 already moved the actual SECRET out of this file, but
 * the entry still carries a per-attach, machine-local loopback URL that is
 * dead the moment this daemon exits. A spawned coding agent running with
 * YOLO-mode autonomy could `git add -A && commit` while attached, and
 * cleanup on detach only ever touches the WORKING TREE — it can't repair a
 * commit already made, so every collaborator who pulls it inherits a
 * `yolo-studio` server pointing at a port nothing is listening on. Same
 * `riskyToCommit` check `local-mcp-trust.ts` uses (round 15), same
 * degraded fallback: `ok: false` (no local MCP access this attach), never
 * a hard failure.
 */

import { readFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_HEADER, SECRET_ENV_VAR } from './mcp-proxy.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { riskyToCommit } from './git-safety.js';

/** The literal string written into `.mcp.json`'s `headers` value — a
 *  template, not the secret itself (Codex review, 2026-08-24, round 12).
 *  Claude Code expands `${VAR}` in `.mcp.json` string fields against its
 *  OWN process env at load time; `cli.ts` sets `SECRET_ENV_VAR` on
 *  `process.env` right before spawning the local agent, which inherits it.
 *  The real random secret this resolves to at runtime never touches any
 *  file this module writes. */
const SECRET_HEADER_TEMPLATE = `\${${SECRET_ENV_VAR}}`;

/** Matches the pod-side writer's own server name (agents.json's
 *  `mcp.servers.yolo-studio` key) — same identity, different transport. */
const SERVER_NAME = 'yolo-studio';

function mcpJsonPath(cwd: string): string {
  return join(cwd, '.mcp.json');
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Malformed existing file — do not clobber it silently by overwriting
    // with a fresh one; treat as unreadable and refuse to touch it (see
    // writeLocalMcpConfig's caller, which logs and skips on `false`).
    throw new Error(`existing ${path} is not valid JSON`);
  }
  // A valid-JSON, non-object root (an array, or a bare scalar like `null`/
  // a number/a string) is just as unsafe to treat as `{}` as malformed JSON
  // is (Codex review, 2026-08-24): `typeof [] === 'object'` passed the old
  // truthy-and-typeof-object check, so an array root would have been cast
  // straight into `Record<string, unknown>` — `config.mcpServers = ...`
  // then silently adds a property onto the operator's array, and the
  // JSON.stringify write below would replace their original array content
  // with an object. Same refuse-rather-than-clobber treatment as bad JSON.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`existing ${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Sidecar file recording the proxy URL this module most recently wrote into
 * `yolo-studio`, kept OUTSIDE `.mcp.json` itself.
 *
 * Round 7-8 tracked ownership with a marker key (`_yolobridge: true`)
 * embedded directly in the `mcpServers.yolo-studio` entry. Codex review,
 * 2026-08-24, round 9, correctly flagged that as broken: Claude Code
 * (v2.0.21+) validates `mcpServers` entries strictly on some releases and
 * rejects unknown fields (anthropics/claude-code#10606) — this repo's own
 * pod-side writer (`containers/services/container-api/mcp-config-writer.js`)
 * already hit exactly this and solved it with an external sidecar rather
 * than an in-entry marker. This file now does the same, adapted to
 * `.mcp.json`'s project-scoped (not home-scoped) design: the entry this
 * module writes is a plain, spec-shaped `{ type: 'http', url, headers }`
 * with no extra keys, so it can never trip strict validation, and
 * ownership is instead established by comparing the entry's `url` against
 * what this sidecar recorded us writing, AND its `headers[SECRET_HEADER]`
 * against the fixed `SECRET_HEADER_TEMPLATE` this module always writes
 * (Codex review, 2026-08-24, round 11 — see `looksLikeOurOwnEntry`'s own
 * doc comment for why `url` alone wasn't enough).
 *
 * Holds only the URL, never the secret (round 12 moved the actual secret
 * out of the project tree entirely — see `SECRET_HEADER_TEMPLATE` above)
 * — still chmod'd owner-only regardless, since even the loopback URL alone
 * is enough to attempt a request against this operator's specific running
 * proxy instance.
 */
function sidecarPath(cwd: string): string {
  return join(cwd, '.yolobridge-mcp-state.json');
}

interface SidecarState {
  proxyUrl?: string;
  /** PID of the process that wrote this record (Codex review, 2026-08-24,
   *  round 19) — see `isPidAlive`'s doc comment for why this exists: a
   *  sidecar match alone can't tell "the attach that wrote this has since
   *  exited" apart from "it's still running, from a SIBLING attach in the
   *  same directory." */
  pid?: number;
}

/** Best-effort read: a missing or corrupt sidecar just means "we don't know
 *  what we last wrote", which correctly makes `looksLikeOurOwnEntry` refuse
 *  to reclaim rather than guess — fail closed, same as everywhere else in
 *  this file. Requires BOTH fields present and correctly typed — a sidecar
 *  missing `pid` (e.g. a half-written file) must not be treated as a
 *  partial match either. */
function readSidecar(cwd: string): SidecarState {
  const path = sidecarPath(cwd);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.proxyUrl === 'string' && typeof parsed.pid === 'number') {
      return { proxyUrl: parsed.proxyUrl, pid: parsed.pid };
    }
  } catch {
    // Corrupt sidecar — treated as absent above.
  }
  return {};
}

/**
 * True if the process that recorded `pid` is (as far as we can tell) still
 * running (Codex review, 2026-08-24, round 19): `looksLikeOurOwnEntry`
 * alone answers "does the on-disk entry match what SOME attach from this
 * module wrote," which is exactly as true for a crashed attach's stale
 * leftover as it is for a SIBLING attach that's still live in the same
 * directory (a real, supported scenario elsewhere in this codebase —
 * "concurrent sibling attach"). Reclaiming the latter would point the
 * shared `.mcp.json` at the wrong proxy for whichever sibling wrote it
 * first, and a later detach could delete the entry out from under a still-
 * running daemon. `process.kill(pid, 0)` is the standard POSIX liveness
 * check (send no actual signal, just probe): ESRCH means no such process
 * (dead — safe to reclaim); EPERM means it exists but we lack permission to
 * signal it (still alive — NOT safe to reclaim); any other outcome is
 * treated as "can't prove it's dead," which fails closed the same way.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeSidecar(cwd: string, state: Required<SidecarState>): void {
  const path = sidecarPath(cwd);
  // Atomic, not a direct overwrite (Codex review, 2026-08-24, round 14): a
  // plain `writeFileSync` on an EXISTING sidecar opens with O_TRUNC, which
  // empties the file BEFORE writing a single new byte — an ENOSPC or crash
  // right there leaves a truncated/corrupt sidecar, which `readSidecar`
  // treats as absent. During a RECLAIM, that "absent" read then means the
  // (unchanged, still genuinely ours) `.mcp.json` entry is permanently
  // misclassified as foreign on every later attach — the exact class of
  // bug round 10/11 fixed for the `.mcp.json` entry itself, just one file
  // over from where this module was already guarding against it.
  atomicWriteFileSync(path, JSON.stringify(state, null, 2) + '\n');
  // Best-effort permission tightening (Codex review, 2026-08-24, round 12):
  // round 11 chmod'd `.mcp.json` but missed this sidecar, which is exactly
  // as readable-by-any-local-account under a typical umask. It no longer
  // carries the secret itself, but it does carry the exact loopback URL of
  // this operator's live proxy instance.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort — a chmod failure leaves weaker-than-ideal permissions,
    // not a broken write.
  }
}

/** Restores whatever the sidecar recorded BEFORE this call started, or
 *  deletes it if nothing was recorded yet — used to undo `writeSidecar`
 *  when the `.mcp.json` write that was supposed to follow it fails (Codex
 *  review, 2026-08-24, round 11): without this, a failed config write
 *  after a successful sidecar write leaves the sidecar pointing at a URL
 *  that was never actually applied to `.mcp.json`, permanently
 *  misclassifying the file's REAL (unchanged) entry as foreign on every
 *  later attach. Best-effort: a failed rollback just leaves the next write
 *  more conservative than it needs to be, never an unsafe reclaim. */
function rollbackSidecar(cwd: string, prior: SidecarState): void {
  try {
    if (prior.proxyUrl !== undefined && prior.pid !== undefined) {
      writeSidecar(cwd, { proxyUrl: prior.proxyUrl, pid: prior.pid });
    } else {
      deleteSidecar(cwd);
    }
  } catch {
    // Best-effort — see doc comment above.
  }
}

function deleteSidecar(cwd: string): void {
  const path = sidecarPath(cwd);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup; a leftover sidecar only ever makes the NEXT
      // write more conservative (it just won't match a differing URL), it
      // never causes an unsafe reclaim.
    }
  }
}

/** Matches ONLY the exact URL shape this module itself ever generates. */
const OWN_ENTRY_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/mcp$/;

/**
 * True if an existing `yolo-studio` entry's `type`/`url`/secret header still
 * exactly match what this module writes — `url` against what the sidecar
 * recorded, and the secret header against the fixed `SECRET_HEADER_TEMPLATE`
 * this module ALWAYS writes (round 12 moved the actual per-attach secret out
 * of `.mcp.json` entirely, so there's no per-attach value left to compare
 * the header against — the template string itself is the invariant) — AND
 * that recorded URL still has the loopback shape this module generates
 * (Codex review, 2026-08-24, round 8's "both signals required" reasoning
 * still applies, now expressed as sidecar-match + shape instead of marker +
 * shape): the sidecar alone isn't enough, because an operator can edit the
 * entry's VALUE (point it somewhere else entirely) WHILE an attachment is
 * still running, without knowing a sidecar exists — a sidecar-only check
 * would then have the NEXT attach overwrite that intentional edit as though
 * it were stale daemon state. Requiring the CURRENT entry to still equal the
 * recorded URL closes that gap: an edited entry no longer matches, so it's
 * correctly left alone even with a stale sidecar record.
 *
 * Round 11: comparing `url` alone missed an edit to `headers` (or another
 * standard field) ONLY — `type`/`url` still matched, so the predicate still
 * said "ours," and cleanup deleted the operator's edited entry wholesale
 * despite this module's own stated "only ever touch exactly what we wrote"
 * guarantee. Now compares the secret header too, so ANY edit to the parts of
 * the entry this module actually controls breaks the match.
 *
 * Round 13: comparing individual field VALUES still missed an ADDITION —
 * an operator (or another config tool) augmenting the entry with an extra
 * header or another standard transport field, while leaving `type`/`url`/
 * the secret header exactly as this module wrote them, still matched every
 * check above. A later attach would then silently drop that addition on
 * reclaim, and detach would delete the whole (augmented) entry. Now
 * requires the entry's own key set, AND its `headers`' key set, to be
 * EXACTLY what this module ever writes — nothing more, nothing less.
 */
function looksLikeOurOwnEntry(value: unknown, recorded: SidecarState): boolean {
  if (!recorded.proxyUrl || !OWN_ENTRY_URL_PATTERN.test(recorded.proxyUrl)) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'headers,type,url') return false;
  if (v.type !== 'http' || v.url !== recorded.proxyUrl) return false;
  const headers = v.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
  const headerKeys = Object.keys(headers as Record<string, unknown>);
  if (headerKeys.length !== 1 || headerKeys[0] !== SECRET_HEADER) return false;
  return (headers as Record<string, unknown>)[SECRET_HEADER] === SECRET_HEADER_TEMPLATE;
}

export interface McpConfigWriteResult {
  ok: boolean;
  /** True only if `.mcp.json` did NOT already exist on disk before this
   *  call (Codex review, 2026-08-24, round 6) — needed at cleanup time:
   *  a pre-existing file that HAPPENED to be empty (`{}` or
   *  `{"mcpServers":{}}`) looks identical, after our entry is removed
   *  again, to a file this module created from scratch. Without tracking
   *  which one actually happened, cleanup would delete a file the
   *  operator already had. */
  createdFile: boolean;
}

/**
 * Adds the `yolo-studio` entry pointing at the local proxy. `ok: false`
 * (does nothing further) if an existing `.mcp.json` can't be parsed, OR if
 * a `yolo-studio` entry is ALREADY there and does NOT look like our own
 * (Codex review, 2026-08-24): a hand-authored entry with that name is the
 * user's own config, not ours to overwrite — and `removeLocalMcpConfig`
 * only ever deletes a value that still matches what was written, so
 * overwriting a genuinely foreign entry here would mean detach later
 * deletes the user's own entry, not just reverts ours. An entry that DOES
 * look like ours (round 6: `looksLikeOurOwnEntry`) is instead treated as a
 * stale leftover from an attachment that exited uncleanly (SIGKILL, crash,
 * reboot — never reached its own `removeLocalMcpConfig` call) and is
 * safely overwritten with the current proxy's URL; refusing unconditionally
 * here would otherwise brick local MCP access on every subsequent attach
 * until the operator manually edited the file.
 */
export function writeLocalMcpConfig(cwd: string, proxyUrl: string): McpConfigWriteResult {
  const path = mcpJsonPath(cwd);
  // Checks the SIDECAR's own path too, not just `.mcp.json`'s (Codex
  // review, 2026-08-24, round 18): a repo's `.gitignore` naming `.mcp.json`
  // specifically says nothing about `.yolobridge-mcp-state.json` — a
  // filename only this module invented, that no operator would think to
  // add preemptively. Without this, a repo that DID think to gitignore
  // `.mcp.json` could still have the sidecar itself swept into a commit,
  // exposing the exact per-attach loopback URL this whole guard exists to
  // keep out of Git.
  if (riskyToCommit(cwd, path) || riskyToCommit(cwd, sidecarPath(cwd))) {
    return { ok: false, createdFile: false };
  }
  const createdFile = !existsSync(path);
  let config: Record<string, unknown>;
  try {
    config = readConfig(path);
  } catch {
    return { ok: false, createdFile: false };
  }
  // `config.mcpServers` gets the SAME root-validation treatment as the file
  // itself (Codex review, 2026-08-24): the old `typeof === 'object'` check
  // also accepts an array (assigning SERVER_NAME onto it is then silently
  // dropped by JSON.stringify -- this would have returned `true` while
  // writing nothing), and silently replaced a PRIMITIVE mcpServers value
  // (e.g. a string) with a fresh `{}`, discarding it. Present-but-invalid
  // is refused, same as an invalid root; only ABSENT defaults to `{}`.
  if ('mcpServers' in config && (config.mcpServers === null || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    return { ok: false, createdFile: false };
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const priorSidecar = readSidecar(cwd);
  if (SERVER_NAME in servers) {
    if (!looksLikeOurOwnEntry(servers[SERVER_NAME], priorSidecar)) return { ok: false, createdFile: false };
    // A content match alone doesn't distinguish a crashed attach's stale
    // leftover from a SIBLING attach that's still live in the same
    // directory — a real, supported scenario elsewhere in this codebase
    // (Codex review, 2026-08-24, round 19). Reclaiming a live sibling's
    // entry would point the shared `.mcp.json` at the WRONG proxy for
    // whichever one wrote it first, and this attach's own later detach
    // could delete the entry out from under that still-running daemon.
    // `priorSidecar.pid` is guaranteed defined here — `looksLikeOurOwnEntry`
    // already required it for the match above to succeed.
    if (priorSidecar.pid !== undefined && isPidAlive(priorSidecar.pid)) return { ok: false, createdFile: false };
  }

  // Sidecar written BEFORE the `.mcp.json` entry itself (Codex review,
  // 2026-08-24, round 10): the original order wrote the entry first, so a
  // sidecar-write failure (e.g. its path collides with a directory, or
  // storage fills between the two writes) left a `yolo-studio` entry
  // already persisted with nothing recording it as ours. The caller never
  // sees `ok: true` in that case, so it never records `mcpConfigCleanup`
  // and can't clean the entry up on detach — and no LATER attach could
  // reclaim it either, since `looksLikeOurOwnEntry` requires a matching
  // sidecar record that was never written. Permanently stranded. Writing
  // the sidecar first means a failure here leaves `.mcp.json` completely
  // untouched — nothing to roll back.
  try {
    writeSidecar(cwd, { proxyUrl, pid: process.pid });
  } catch {
    return { ok: false, createdFile: false };
  }
  // Plain, spec-shaped entry — no ownership marker inside it (round 9): an
  // unknown field here is exactly what a strict-validating Claude Code
  // release rejects the whole server entry over. `headers` IS a standard
  // field for an http-type entry (Claude Code's own docs; this repo's
  // pod-side writer emits the identical shape,
  // containers/services/container-api/mcp-config-writer.js:191). Its value
  // is a `${VAR}` TEMPLATE, not the actual secret (round 12 — see
  // `SECRET_HEADER_TEMPLATE`'s doc comment): the real per-attach secret the
  // proxy requires on every request never touches this (often git-tracked)
  // file.
  servers[SERVER_NAME] = { type: 'http', url: proxyUrl, headers: { [SECRET_HEADER]: SECRET_HEADER_TEMPLATE } };
  config.mcpServers = servers;
  try {
    // Atomic (temp file + rename), not a direct overwrite (Codex review,
    // 2026-08-24, round 13): a direct `writeFileSync` on an EXISTING file
    // truncates it before writing the new bytes, so ENOSPC or a crash
    // mid-write can leave the OPERATOR's file half-written — unrecoverable,
    // unlike every other failure mode this function already refuses to
    // touch the file for.
    atomicWriteFileSync(path, JSON.stringify(config, null, 2) + '\n');
  } catch {
    // The sidecar-write-first ordering above is only harmless in the "no
    // prior entry existed" case (round 10's own reasoning). When RECLAIMING
    // a stale entry (`SERVER_NAME in servers` above), the sidecar already
    // held a valid record matching the entry still on disk — round 11:
    // overwriting it with the NEW url and then failing here would strand
    // that valid record too, permanently misclassifying the (unchanged)
    // on-disk entry as foreign. Roll back to whatever was there before this
    // call.
    rollbackSidecar(cwd, priorSidecar);
    return { ok: false, createdFile: false };
  }
  // Best-effort permission tightening (Codex review, 2026-08-24, round 11;
  // no longer strictly about the secret since round 12 moved that out of
  // this file — kept as defense-in-depth against exposing the loopback
  // port/URL itself to another local account). `writeFileSync`'s default
  // mode only applies at file CREATION — an EXISTING file keeps whatever
  // permissions it already had (commonly 0644/0664 under a typical umask).
  // A chmod failure here (e.g. an FS that doesn't support it) does not roll
  // back the write above: the entry and sidecar are already consistent
  // with each other, just left at weaker-than-ideal permissions rather than
  // an unrecoverable state.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort — see comment above.
  }
  return { ok: true, createdFile };
}

/**
 * Removes exactly the `yolo-studio` entry this module added — but ONLY if
 * its value still matches exactly what `writeLocalMcpConfig` wrote
 * (`expectedProxyUrl`, the same one passed to that call) — Codex review,
 * 2026-08-24, round 5: over a long-running attachment, the operator (or
 * another `claude mcp add`/hand edit) could replace that entry with
 * something else entirely; blind deletion keyed only on "did WE create
 * this key originally" would destroy that newer, unrelated edit too. A
 * changed value is left completely alone, matching an unparseable file's
 * treatment — this function only ever removes the EXACT thing it added.
 *
 * If that leaves `.mcp.json` with no `mcpServers` entries and nothing else
 * in the file, deletes the file entirely — but ONLY when `createdFile`
 * (from `writeLocalMcpConfig`'s own return) says THIS attachment is the one
 * that created it. Codex review, 2026-08-24, round 6: emptiness alone isn't
 * proof of that — a repo that already had an empty `.mcp.json` or
 * `{"mcpServers":{}}` looks identical, once our entry is removed, to one
 * this module created from scratch, and unlinking it would delete a file
 * the operator already had. When it's empty but NOT ours to delete, the
 * (now-empty-of-our-stuff) config is written back instead, same as any
 * other "file had other content" case.
 *
 * The sidecar (round 9) is only ever deleted when it still records exactly
 * `expectedProxyUrl` — the same re-verify-before-touching discipline as the
 * `.mcp.json` entry itself, so a concurrent sibling attach that already
 * overwrote the sidecar with ITS OWN newer URL is never clobbered here.
 */
export function removeLocalMcpConfig(cwd: string, expectedProxyUrl: string, createdFile: boolean): void {
  const path = mcpJsonPath(cwd);
  if (!existsSync(path)) {
    if (readSidecar(cwd).proxyUrl === expectedProxyUrl) deleteSidecar(cwd);
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = readConfig(path);
  } catch {
    // Can't safely edit a file we can't parse — leave it alone.
    return;
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  const current = servers[SERVER_NAME] as { type?: unknown; url?: unknown } | undefined;
  const recordedSidecar = readSidecar(cwd);
  if (!current || current.type !== 'http' || current.url !== expectedProxyUrl || !looksLikeOurOwnEntry(current, recordedSidecar)) return;
  delete servers[SERVER_NAME];

  const hasOtherServers = Object.keys(servers).length > 0;
  const otherTopLevelKeys = Object.keys(config).filter((k) => k !== 'mcpServers');

  if (createdFile && !hasOtherServers && otherTopLevelKeys.length === 0) {
    unlinkSync(path);
    if (recordedSidecar.proxyUrl === expectedProxyUrl) deleteSidecar(cwd);
    return;
  }

  config.mcpServers = servers;
  // Atomic (temp file + rename) — see the doc comment on the equivalent
  // write in `writeLocalMcpConfig` (Codex review, 2026-08-24, round 13): a
  // direct overwrite could leave the operator's other, unrelated content
  // in this file half-written on an ENOSPC or crash.
  atomicWriteFileSync(path, JSON.stringify(config, null, 2) + '\n');
  if (recordedSidecar.proxyUrl === expectedProxyUrl) deleteSidecar(cwd);
}
