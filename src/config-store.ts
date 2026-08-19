/**
 * Local on-disk state for the YoloBridge daemon: the device-flow auth
 * tokens from `yolo-bridge login`, and the current attachment record from
 * `yolo-bridge attach`. Config dir choice (docs/YOLOBRIDGE_PLAN.md's
 * historical §1.1 already named this location for the superseded design;
 * kept for this build too): `~/.config/yolobridge/`.
 *
 *   ~/.config/yolobridge/auth.json        — device-flow token pair
 *   ~/.config/yolobridge/attachment.json  — current workspace attachment
 *
 * Both files are written with mode 0600 (best-effort — not enforced on
 * every platform) since `auth.json` holds a live Bearer-equivalent
 * credential. Follows the same injectable-I/O pattern as
 * `packages/yolo-cli/src/auth-context.ts` (`ReadFileImpl`) so callers can
 * unit test against an in-memory stub instead of the real filesystem.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  /** Absolute epoch-ms expiry of `accessToken`, computed at save time. */
  expiresAtMs: number;
}

export interface StoredAttachment {
  workspaceId: string;
  tileId: string;
  attachmentId: string;
  attachedAt: string;
}

/** Minimal FS surface this module needs — injectable for tests. */
export interface ConfigStoreIO {
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, contents: string): void;
  removeFile(filePath: string): void;
}

export const defaultIO: ConfigStoreIO = {
  readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  },
  writeFile(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
  },
  removeFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone — fine */
    }
  },
};

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || os.homedir();
  return path.join(home, '.config', 'yolobridge');
}

function authPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), 'auth.json');
}

function attachmentPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), 'attachment.json');
}

export function loadAuth(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): StoredAuth | undefined {
  const raw = io.readFile(authPath(env));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.tokenType === 'string' &&
      typeof parsed.expiresAtMs === 'number'
    ) {
      return parsed as StoredAuth;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveAuth(
  auth: StoredAuth,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.writeFile(authPath(env), `${JSON.stringify(auth, null, 2)}\n`);
}

export function clearAuth(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.removeFile(authPath(env));
}

export function loadAttachment(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): StoredAttachment | undefined {
  const raw = io.readFile(attachmentPath(env));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAttachment>;
    if (
      typeof parsed.workspaceId === 'string' &&
      typeof parsed.tileId === 'string' &&
      typeof parsed.attachmentId === 'string' &&
      typeof parsed.attachedAt === 'string'
    ) {
      return parsed as StoredAttachment;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveAttachment(
  attachment: StoredAttachment,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.writeFile(attachmentPath(env), `${JSON.stringify(attachment, null, 2)}\n`);
}

export function clearAttachment(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.removeFile(attachmentPath(env));
}
