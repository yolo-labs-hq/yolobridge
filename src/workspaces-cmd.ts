/**
 * `yolo-bridge workspaces` — lists the caller's own selectable workspaces
 * (`GET /v1/workspaces/selectable` via api-client.ts's
 * `listSelectableWorkspaces`), so a user running `yolo-bridge attach` for
 * the first time has somewhere to find a workspaceId without already
 * knowing a raw MongoDB ObjectId. Non-interactive/scriptable: plain text
 * to stdout, no prompting, safe to pipe.
 */

import { listSelectableWorkspaces, type SelectableWorkspace, type FetchImpl } from './api-client.js';
import { loadAuth, type ConfigStoreIO } from './config-store.js';

export interface ListWorkspacesDeps {
  commonApiBaseUrl: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: FetchImpl;
}

export type ListWorkspacesResult =
  | { ok: true; workspaces: SelectableWorkspace[] }
  | { ok: false; reason: 'not-logged-in' | 'error'; message: string };

export async function runListWorkspaces(deps: ListWorkspacesDeps): Promise<ListWorkspacesResult> {
  const auth = loadAuth(deps.env, deps.io);
  if (!auth) return { ok: false, reason: 'not-logged-in', message: 'Not logged in — run `yolo-bridge login` first.' };

  try {
    const workspaces = await listSelectableWorkspaces({
      commonApiBaseUrl: deps.commonApiBaseUrl,
      accessToken: auth.accessToken,
      fetchImpl: deps.fetchImpl,
    });
    return { ok: true, workspaces };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Renders a simple aligned-columns table: id, name, status per row. */
export function formatWorkspacesTable(workspaces: SelectableWorkspace[]): string {
  if (workspaces.length === 0) {
    return 'No workspaces found.';
  }
  const idWidth = Math.max('ID'.length, ...workspaces.map((w) => w.id.length));
  const nameWidth = Math.max('NAME'.length, ...workspaces.map((w) => (w.name || '(unnamed)').length));
  const header = `${'ID'.padEnd(idWidth)}  ${'NAME'.padEnd(nameWidth)}  STATUS`;
  const rows = workspaces.map(
    (w) => `${w.id.padEnd(idWidth)}  ${(w.name || '(unnamed)').padEnd(nameWidth)}  ${w.status}`,
  );
  return [header, ...rows].join('\n');
}
