/**
 * `yolo-bridge detach` — calls `DELETE /attach/:attachmentId` and clears
 * the locally stored attachment record.
 *
 * Note on "stops the daemon loop" (build-order step 5's requirement):
 * this command and a running `yolo-bridge attach` daemon are typically
 * two SEPARATE OS processes (attach runs in the foreground holding the
 * SSE connection). `detach` doesn't reach into that other process
 * directly — instead it relies on the real server behavior already
 * implemented in `yolobridge-service.ts`'s `detachDaemon`: the DELETE
 * writes a `detached` SSE frame onto the held stream before closing it
 * (`writeFrame(held.res, 'detached', ...)`). The running attach daemon's
 * frame dispatcher (frame-actions.ts → attach-cmd.ts) treats that frame
 * as a clean stop signal and exits its own loop. So `detach` from a
 * second terminal really does stop the daemon loop, just via the
 * existing server round trip rather than an OS-level signal. Ctrl+C on
 * the attach process itself is the separate, local stop path (wired in
 * cli.ts).
 */

import { detach as apiDetach, type FetchImpl } from './api-client.js';
import {
  loadAuth,
  loadAttachment,
  clearAttachment,
  clearStoredScopedToken,
  type ConfigStoreIO,
} from './config-store.js';

export interface DetachDeps {
  commonApiBaseUrl: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: FetchImpl;
}

export type DetachResult =
  | { ok: true }
  | { ok: false; reason: 'not-logged-in' | 'not-attached' | 'error'; message: string };

export async function runDetach(deps: DetachDeps): Promise<DetachResult> {
  const auth = loadAuth(deps.env, deps.io);
  if (!auth) return { ok: false, reason: 'not-logged-in', message: 'Not logged in — run `yolo-bridge login` first.' };

  const attachment = loadAttachment(deps.env, deps.io);
  if (!attachment) return { ok: false, reason: 'not-attached', message: 'No active attachment found.' };

  try {
    await apiDetach(
      { commonApiBaseUrl: deps.commonApiBaseUrl, accessToken: auth.accessToken, fetchImpl: deps.fetchImpl },
      attachment.workspaceId,
      attachment.attachmentId,
    );
  } catch (err) {
    // The attachment RECORD is deliberately kept on a genuine failure so the
    // retry path knows what to retry against — but the workspace-scoped
    // credential stored alongside it is not part of that retry (this command
    // authenticates the DELETE with the account token) and the server refuses
    // it the moment the attachment stops being live. Keeping it would leave a
    // dead credential sitting in a file whose only remaining risk is being
    // read by someone else. Card 08.
    clearStoredScopedToken(deps.env, deps.io);
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  clearStoredScopedToken(deps.env, deps.io);
  clearAttachment(deps.env, deps.io);
  return { ok: true };
}
