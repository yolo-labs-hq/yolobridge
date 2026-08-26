/**
 * Tools the daemon serves ITSELF, instead of forwarding to the cloud MCP.
 *
 * WHY ANY TOOL IS LOCAL. `mcp-proxy.ts` forwards the attached agent's MCP
 * traffic to the cloud `yolo-studio-mcp`, and the agent already has full
 * workspace-wide scope there. But a cloud tool executes in the cloud and cannot
 * read the operator's disk. Sharing a local file is therefore the one thing the
 * proxy has to answer on its own.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO KEEP:
 *
 *   1. A local call is NEVER FORWARDED, so the operator's file never becomes a
 *      cloud request, and no delegated cloud token is minted for it. The
 *      interception in `mcp-proxy.ts` runs BEFORE `getToken()` for exactly this
 *      reason — see the call site.
 *   2. The upload opens the RESOLVED path the approval check returned, never
 *      the string the agent passed. Checking one path and opening another is
 *      how symlink containment gets defeated: an in-tree link can be repointed
 *      between the two.
 *
 * ⚠️ THE APPROVAL LIST IS NOT A SECURITY BOUNDARY. The agent runs as the same
 * OS user with shell access, so it can widen the list itself, and it could
 * already `curl -T` a file out without us. What this buys is that ACCIDENTS are
 * prevented, the credentialed path stays deliberate, and grants are auditable.
 * Do not write a message here claiming more than that.
 */

import { checkPathApproved } from './approved-paths.js';
import { runShare, describeShareFailure, type ShareResult } from './share-cmd.js';

/** Namespaced so it can never collide with a forwarded cloud tool name. */
export const SHARE_FILE_TOOL = 'yolobridge_share_file';

export const LOCAL_TOOL_DEFINITIONS = [
  {
    name: SHARE_FILE_TOOL,
    description:
      'Send a file from the LOCAL machine this agent is running on up to the cloud workspace, '
      + 'so a cloud agent can see it. Push only — this cannot read paths the operator has not '
      + 'approved, and nothing in the cloud can pull files from this machine.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the local file to send. Must be inside an approved directory.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
] as const;

export interface LocalToolContext {
  workspaceId: string;
  /** Implicitly-approved roots — the daemon's working directory. */
  implicitRoots: string[];
  commonApiBaseUrl: string;
  /**
   * The upload runs through `runShare`, which reloads the attachment and its
   * workspace-scoped credential from disk on every call.
   *
   * That is deliberate rather than incidental: the scoped token ROTATES, so
   * capturing one when the proxy starts would work for a while and then 403
   * for the rest of a long attachment — the same trap `getAccessToken` exists
   * to avoid on the cloud side of this proxy.
   */
  shareImpl?: typeof runShare;
  checkImpl?: typeof checkPathApproved;
}

/** A JSON-RPC id, as it appears on the wire. */
type RpcId = string | number | null;

function toolResult(id: RpcId, text: string, isError = false): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
  };
}

/** Is this parsed JSON-RPC message a call to one of our local tools? */
export function isLocalToolCall(msg: unknown): boolean {
  const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
  if (!m || m.method !== 'tools/call') return false;
  return typeof m.params?.name === 'string'
    && LOCAL_TOOL_DEFINITIONS.some((t) => t.name === m.params!.name);
}

/**
 * Run one local tool call and produce its JSON-RPC response.
 *
 * Errors come back as a tool result with `isError`, not a JSON-RPC error: a
 * refused path is a normal answer the agent should read and act on, not a
 * protocol fault.
 */
export async function runLocalToolCall(
  msg: { id?: RpcId; params?: { name?: string; arguments?: Record<string, unknown> } },
  ctx: LocalToolContext,
): Promise<Record<string, unknown> | undefined> {
  // A message with NO `id` is a notification: JSON-RPC says do the work and
  // send nothing back. `msg.id ?? null` would have turned that into a normal
  // reply carrying `id: null` — a spurious entry in a batch, and a body where a
  // notification-only request expects none. An EXPLICIT null id is a different
  // thing and still gets answered. (codex P2, gpt-5.6-sol.)
  const isNotification = !('id' in msg);
  const id = msg.id ?? null;
  const name = msg.params?.name;
  const args = msg.params?.arguments ?? {};

  if (name !== SHARE_FILE_TOOL) {
    return isNotification ? undefined : toolResult(id, `Unknown local tool: ${String(name)}`, true);
  }

  const rawPath = typeof args.path === 'string' ? args.path : '';
  if (!rawPath) return isNotification ? undefined : toolResult(id, 'A `path` is required.', true);

  const check = (ctx.checkImpl ?? checkPathApproved)(rawPath, ctx.workspaceId, ctx.implicitRoots);
  if (!check.approved || !check.resolvedPath) {
    return isNotification ? undefined : toolResult(id, check.reason ?? `${rawPath} is not an approved path.`, true);
  }

  try {
    // Property 2: open what the check RESOLVED, not what the caller passed.
    const result: ShareResult = await (ctx.shareImpl ?? runShare)(check.resolvedPath, {
      commonApiBaseUrl: ctx.commonApiBaseUrl,
      // The approval was checked against THIS workspace. The attachment on disk
      // can have been replaced by a second `attach` since the proxy started, so
      // bind the upload to the same workspace or refuse. (codex P2.)
      expectedWorkspaceId: ctx.workspaceId,
      write: () => { /* progress belongs to the operator's terminal, not the agent's transcript */ },
    });
    if (isNotification) return undefined;
    if (!result.ok) return toolResult(id, result.message, true);
    return toolResult(id, `Shared as asset ${result.assetId}. It is now visible in the cloud workspace.`);
  } catch (err) {
    return isNotification ? undefined : toolResult(id, describeShareFailure(err), true);
  }
}

export interface LocalInterception {
  /** Reply to send WITHOUT forwarding. Absent when every local message was a
   *  NOTIFICATION, which JSON-RPC says must not be answered. */
  localResponse?: string;
  /** What still needs forwarding, or undefined if nothing does. */
  forwardBody?: string;
  /** Ids answered locally, so a batch reply can be merged in order. */
  localIds: Array<RpcId>;
}

/**
 * Split an incoming body into "answered here" and "still needs the cloud".
 *
 * Handles the batch form because `injectToken` already has to, and a batch that
 * mixes a local tool with cloud tools must not lose either half.
 *
 * Returns `undefined` when nothing is local — the overwhelmingly common case,
 * so the normal path pays one `JSON.parse` and nothing else.
 */
export async function interceptLocalTools(
  rawBody: string,
  ctx: LocalToolContext,
): Promise<LocalInterception | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    if (!isLocalToolCall(parsed)) return undefined;
    const response = await runLocalToolCall(parsed as any, ctx);
    // A notification produced no response; there is still nothing to forward.
    return response
      ? { localResponse: JSON.stringify(response), localIds: [(parsed as any).id ?? null] }
      : { localIds: [] };
  }

  const localIdx = parsed.map((m, i) => (isLocalToolCall(m) ? i : -1)).filter((i) => i >= 0);
  if (!localIdx.length) return undefined;

  const responses: Array<Record<string, unknown>> = [];
  for (const i of localIdx) {
    const r = await runLocalToolCall(parsed[i] as any, ctx);
    if (r) responses.push(r);
  }

  const remainder = parsed.filter((_, i) => !localIdx.includes(i));
  return {
    localResponse: responses.length ? JSON.stringify(responses) : undefined,
    forwardBody: remainder.length ? JSON.stringify(remainder) : undefined,
    localIds: localIdx.map((i) => (parsed[i] as any)?.id ?? null),
  };
}


/**
 * Does this request contain a `tools/list`, whose reply we must rewrite to
 * advertise the locally-served tools?
 */
export function requestWantsToolsList(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((m: any) => m?.method === 'tools/list');
  } catch {
    return false;
  }
}


/**
 * The upstream may answer a POST as plain JSON **or** as an SSE stream — it
 * chooses, and this proxy must advertise both. (The MCP SDK's
 * `WebStandardStreamableHTTPServerTransport.handlePostRequest` returns 406
 * unless the client accepts BOTH `application/json` and `text/event-stream`,
 * verified in the installed SDK 1.29.0 — so narrowing the Accept header to dodge
 * SSE is not an option, it breaks every request outright.)
 *
 * So anything that rewrites a response has to understand both shapes. These two
 * helpers pull the JSON-RPC messages out of whichever it is, and put them back
 * in the SAME shape, so the client sees the framing it negotiated.
 */
export interface RpcEnvelope {
  messages: any[];
  /** Rebuild a body of the original shape from (possibly changed) messages. */
  rebuild: (messages: any[]) => string;
}

const SSE_DATA = /^data:\s?(.*)$/;

export function parseRpcEnvelope(text: string): RpcEnvelope | undefined {
  const trimmed = text.trimStart();

  // Plain JSON — the common case.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const wasArray = Array.isArray(parsed);
      return {
        messages: wasArray ? parsed : [parsed],
        rebuild: (m) => JSON.stringify(wasArray ? m : (m[0] ?? null)),
      };
    } catch {
      return undefined;
    }
  }

  // SSE framing: one or more `data:` lines, blank-line separated.
  if (!/(^|\n)data:/.test(text)) return undefined;
  const lines = text.split(/\r?\n/);
  const dataIdx: number[] = [];
  const messages: any[] = [];
  lines.forEach((line, i) => {
    const m = SSE_DATA.exec(line);
    if (!m) return;
    try {
      messages.push(JSON.parse(m[1]!));
      dataIdx.push(i);
    } catch {
      /* a non-JSON data line (a keepalive, say) is left exactly as it is */
    }
  });
  if (!messages.length) return undefined;

  return {
    messages,
    rebuild: (next) => {
      const out = [...lines];
      // Rewrite the frames we parsed, in order...
      next.slice(0, dataIdx.length).forEach((msg, i) => {
        out[dataIdx[i]!] = `data: ${JSON.stringify(msg)}`;
      });
      // ...and append any EXTRA messages as their own frames, so a merged-in
      // local result reaches a client that negotiated a stream.
      const extra = next.slice(dataIdx.length);
      const tail = extra.map((msg) => `event: message\ndata: ${JSON.stringify(msg)}\n`);
      return tail.length ? `${out.join('\n').replace(/\n*$/, '\n\n')}${tail.join('\n')}\n` : out.join('\n');
    },
  };
}

/**
 * Add our tools to an upstream `tools/list` reply, so the agent can discover
 * them alongside the cloud ones.
 *
 * Returns the text unchanged on anything unexpected — a malformed or
 * error-shaped upstream reply must pass through untouched rather than be
 * rewritten into something that only looks well-formed.
 */
export function augmentToolsList(requestBody: string, responseText: string): string {
  let request: unknown;
  try {
    request = JSON.parse(requestBody);
  } catch {
    return responseText;
  }
  const requests = Array.isArray(request) ? request : [request];
  const listIds = new Set(
    requests
      .filter((m: any) => m?.method === 'tools/list')
      .map((m: any) => m?.id)
      .filter((id: unknown) => id !== undefined),
  );
  if (!listIds.size) return responseText;

  const envelope = parseRpcEnvelope(responseText);
  if (!envelope) return responseText;

  let changed = false;
  for (const m of envelope.messages as any[]) {
    if (!listIds.has(m?.id)) continue;
    if (!Array.isArray(m?.result?.tools)) continue;
    // Paginated discovery: a client that follows `nextCursor` aggregates every
    // page, so appending on each one yields duplicate tool names and an
    // ambiguous or rejected registration. Add them to the FINAL page only, so
    // they appear exactly once across the sequence. (codex P2.)
    if (m.result.nextCursor !== undefined && m.result.nextCursor !== null) continue;
    const present = new Set(m.result.tools.map((t: any) => t?.name));
    for (const def of LOCAL_TOOL_DEFINITIONS) {
      if (!present.has(def.name)) { m.result.tools.push({ ...def }); changed = true; }
    }
  }
  return changed ? envelope.rebuild(envelope.messages) : responseText;
}
