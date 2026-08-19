/**
 * Parser for the exact SSE framing `yolobridge-service.ts`'s `writeFrame`
 * emits (`common-api/src/services/yolobridge-service.ts:122-136`):
 *
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * No `id:` line (deliberate — see that file's comment: this stream has no
 * replay buffer). Frame types actually written by the server today:
 *   - `connected`    { attachmentId, workspaceId, timestamp }   (holdStream)
 *   - `ping`         { t }                                       (holdStream keepalive, ~30s)
 *   - `prompt`       { attachmentId, prompt }                    (publishPrompt)
 *   - `read-output`  { attachmentId, requestId }                 (requestReadOutput)
 *   - `detached`     { attachmentId }                             (detachDaemon)
 *
 * Pure incremental parser: feed it raw chunks as they arrive off the wire
 * (chunk boundaries need not align with frame boundaries — a `data:` line
 * can legitimately split across two `write()` calls under backpressure),
 * get back zero or more complete frames per `push()` call. No network or
 * timer code in this file — fully unit-testable without a real stream.
 */

export interface SseFrame {
  event: string;
  data: unknown;
  /** Raw `data:` payload before JSON.parse, kept for a frame whose body isn't JSON. */
  raw: string;
}

export class SseFrameParser {
  private buffer = '';

  /** Feed a raw chunk (already decoded to a string). Returns any complete frames it produced. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    // Frames are separated by a blank line (`\n\n`). Split conservatively:
    // keep the trailing partial block in the buffer for the next push().
    let sepIndex: number;
    while ((sepIndex = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, sepIndex);
      this.buffer = this.buffer.slice(sepIndex + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message'; // SSE default event name when no `event:` line is present.
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
    // Any other line (comments, unrecognized fields) is ignored — this
    // stream never sends `id:`/`retry:`.
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = undefined;
  }
  return { event, data, raw };
}
