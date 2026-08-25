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
  // Still a real precondition, but no longer the credential: `auth.json` is
  // what makes this a set-up machine at all, and its absence has a much better
  // remedy to offer than a 403 would.
  if (!loadAuth(deps.env, deps.io)) {
    return { ok: false, reason: 'not-logged-in', message: 'Not logged in — run `yolo-bridge login` first.' };
  }

  const attachment = loadAttachment(deps.env, deps.io);
  if (!attachment) return { ok: false, reason: 'not-attached', message: 'No active attachment found.' };

  // READ THE CREDENTIAL BEFORE ANY CLEARING BELOW. `DELETE .../attach/:id` is a
  // daemon-only route behind Boundary B (card 09): an account token is refused
  // there with 403 YOLOBRIDGE_SCOPED_TOKEN_REQUIRED, so this command must
  // present the workspace-scoped credential `attach` persisted alongside the
  // attachment identity — the same one the running daemon uses.
  const scopedToken = attachment.scopedToken;
  if (!scopedToken) {
    // No credential the daemon surface will accept, and nothing on this machine
    // can mint one for an attachment that already exists. Say so plainly rather
    // than sending an account token to be refused: the operator's real remedy
    // is to let the tile go stale on its own (the server stops it once the
    // heartbeat lapses) or to re-attach.
    return {
      ok: false,
      reason: 'error',
      message:
        'No workspace-scoped credential is stored for this attachment, so it cannot be '
        + 'detached from this machine. The tile stops on its own once its heartbeat lapses; '
        + 'run `yolo-bridge attach` to reconnect.',
    };
  }

  try {
    await apiDetach(
      { commonApiBaseUrl: deps.commonApiBaseUrl, accessToken: scopedToken, fetchImpl: deps.fetchImpl },
      attachment.workspaceId,
      attachment.attachmentId,
    );
  } catch (err) {
    // The attachment RECORD is deliberately kept on a genuine failure so the
    // retry path knows what to retry against — but the stored credential is
    // stripped, per card 08: the server refuses it the moment the attachment
    // stops being live, so what is left is residue that can only be leaked.
    //
    // KNOWN CONSEQUENCE of card 09 layering on top of that, not silently
    // absorbed: the credential is now what authenticates the retry too, so
    // stripping it here means a second `yolo-bridge detach` takes the
    // no-credential branch above instead of retrying. The record still tells
    // `status` what happened, and the server still reaps the attachment on
    // heartbeat lapse, so nothing is stranded that would not have been —
    // but D5's "the retry path authenticates with the account token" is no
    // longer true and is recorded as such in D6.
    clearStoredScopedToken(deps.env, deps.io);
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  clearStoredScopedToken(deps.env, deps.io);
  clearAttachment(deps.env, deps.io);
  return { ok: true };
}
