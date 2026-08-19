/**
 * STUBS — deliberately not wired to a real local coding-agent session.
 *
 * docs/YOLOBRIDGE_PLAN.md's Architecture section says a received prompt
 * frame should be delivered "to the user's already-running local
 * coding-agent session the way the user's own terminal would" — but does
 * NOT prescribe a mechanism, and the underspecification is real: there
 * are several plausible approaches with very different failure modes,
 * and picking wrong here is the kind of mistake that's hard to detect
 * later (a "delivery" that silently goes nowhere looks identical to a
 * successful one from the server's point of view once `publishPrompt`
 * resolves).
 *
 * OPEN IMPLEMENTATION QUESTION — candidates considered, none implemented:
 *   1. Terminal injection — locate the user's actual Claude Code/Codex
 *      terminal (which one, if several are open?) and synthesize
 *      keystrokes/paste into it. Fragile across terminal emulators, OS
 *      accessibility permissions required on macOS.
 *   2. A well-known named pipe / Unix socket that a running Claude Code
 *      session reads from — requires that session to opt in to listening
 *      (a companion hook/plugin on the agent side that doesn't exist yet).
 *   3. Clipboard + notification — copy the prompt, notify the user to
 *      paste it themselves. Loses the "no new consent/approval layer"
 *      property the plan explicitly wants (Trust model section) since it
 *      reintroduces a manual step, but is the only option requiring zero
 *      cooperation from the local agent.
 *   4. Spawn the agent directly as a subprocess YoloBridge owns (closer to
 *      the superseded Step-Run-dispatch draft) — rejected by the current
 *      plan's own Non-goals ("not a capability/consent envelope … the
 *      local agent should be already-running, not launched by YoloBridge").
 *
 * This function's contract is deliberately narrow so wiring in a real
 * mechanism later doesn't require touching any caller: it receives the
 * raw prompt string and returns once "delivery" (whatever that ends up
 * meaning) is attempted.
 */
export async function deliverPromptToLocalAgent(prompt: string): Promise<void> {
  const banner = '─'.repeat(60);
  process.stdout.write(
    `\n${banner}\n[yolobridge] PROMPT RECEIVED (delivery mechanism not yet implemented — see local-agent.ts)\n${banner}\n${prompt}\n${banner}\n\n`,
  );
  // STUB: no actual delivery into a running local agent session happens
  // here. See the open-question block above.
}

/**
 * STUB — same honesty as `deliverPromptToLocalAgent` above: there is no
 * real "read the local agent's current output" implementation yet, for
 * the same reason (no defined channel into an already-running local
 * session). What IS real: the round-trip protocol this feeds — the
 * caller posts this stub's return value back to common-api via
 * `POST /events {type:'read-output-reply', requestId, output, busy}`, so
 * the correlation plumbing (`requestReadOutput` on the server side) is
 * exercisable end-to-end today; only the content of `output` is a
 * placeholder.
 */
export async function captureLocalAgentOutput(): Promise<{ output: string; busy: boolean }> {
  return {
    output: '[yolobridge] captureLocalAgentOutput is a stub — no local-agent output channel wired up yet.',
    busy: false,
  };
}
