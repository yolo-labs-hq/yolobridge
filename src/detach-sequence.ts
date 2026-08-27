/**
 * The detach escape sequence for `yolo-bridge attach`.
 *
 * WHY THIS EXISTS. `cli.ts` registers `process.on('SIGINT', …)` as the daemon's
 * stop path, and `local-agent.ts` puts stdin into RAW MODE so every byte can be
 * forwarded to the agent's PTY. Raw mode is precisely the mode in which the
 * tty stops translating `\x03` into SIGINT — so that handler is not merely at
 * risk of being missed, it is UNREACHABLE from the keyboard for as long as an
 * agent is attached. The operator presses Ctrl+C expecting to quit, gets
 * silence, and the teardown never runs.
 *
 * ⚠️ THE FIX IS NOT TO GIVE Ctrl+C BACK TO THE DAEMON. Forwarding it to the
 * agent is the more valuable behaviour by a wide margin — interrupting a
 * runaway agent is the thing an operator actually needs mid-session, and a
 * daemon that quit instead would take the agent down with it. So Ctrl+C keeps
 * going to the agent and the daemon gets its own key.
 *
 * `Ctrl-P Ctrl-Q`, following `docker attach`. Chosen because it is vanishingly
 * rare in agent TUIs: `Ctrl-C`, `Ctrl-D`, `Ctrl-Z` and a lone `Ctrl-Q` are all
 * in active use by the CLIs this daemon spawns, and stealing any of them would
 * trade one broken key for another.
 */

/** `Ctrl-P` — the prefix. Held back until the next byte decides its meaning. */
export const DETACH_PREFIX_BYTE = 0x10;
/** `Ctrl-Q` — only a detach when it IMMEDIATELY follows the prefix. */
export const DETACH_SUFFIX_BYTE = 0x11;

/**
 * ⚠️ A HELD PREFIX IS NOT RELEASED ON A TIMER, deliberately.
 *
 * The first version of this expired the prefix after 250ms so a lone `Ctrl-P`
 * would reach the agent promptly. That made the ONLY keyboard-accessible stop
 * path depend on typing speed: an operator taking longer than a quarter second
 * between two unfamiliar chords — or a busy event loop delaying the second
 * stdin event — would silently get a forwarded `Ctrl-P` and no detach. That is
 * the very bug this change exists to fix, reintroduced with a stopwatch.
 * (codex P2.)
 *
 * So the prefix is held until the NEXT BYTE decides its meaning, however long
 * that takes — the same as `docker attach`.
 *
 * The cost, stated plainly: a lone `Ctrl-P` does not reach the agent until the
 * operator presses another key. For an agent that binds `Ctrl-P` to history
 * that is a one-keystroke lag. It is the right trade — a stop key that works
 * every time beats a history key that is never late — and it is bounded, since
 * pressing `Ctrl-P` twice flushes the first immediately.
 */

export interface DetachSequenceFilterOptions {
  /** Forward these bytes to the PTY. */
  emit: (data: string) => void;
  /** The full sequence was typed. */
  onDetach: () => void;
}

export interface DetachSequenceFilter {
  /** Feed one chunk of stdin. */
  push: (data: string) => void;
  /** Drop any held prefix — for teardown. */
  dispose: () => void;
}

/**
 * Splits a stdin stream into "detach" and "everything else".
 *
 * Byte-oriented and chunk-agnostic on purpose: in raw mode each keypress
 * usually arrives as its own chunk, but nothing guarantees it, so the two
 * bytes of the sequence may land together or apart and must behave identically
 * either way.
 *
 * ⚠️ A PREFIX FOLLOWED BY ANYTHING ELSE FORWARDS BOTH BYTES. Swallowing the
 * `Ctrl-P` would silently break it for agents that use it, which is the same
 * class of bug this whole change exists to fix.
 */
export function createDetachSequenceFilter(opts: DetachSequenceFilterOptions): DetachSequenceFilter {
  let prefixPending = false;
  let detached = false;

  return {
    push(data: string) {
      // Once detached, further keystrokes belong to a session that is going
      // away; forwarding them would race the teardown.
      if (detached) return;

      let out = '';
      for (let i = 0; i < data.length; i++) {
        const code = data.charCodeAt(i);

        if (prefixPending) {
          prefixPending = false;
          if (code === DETACH_SUFFIX_BYTE) {
            // Emit whatever preceded the sequence, then stop. The prefix and
            // suffix are consumed and never reach the agent.
            if (out) opts.emit(out);
            detached = true;
            opts.onDetach();
            return;
          }
          // Not the suffix: the prefix was an ordinary keystroke after all.
          out += String.fromCharCode(DETACH_PREFIX_BYTE);
          // Fall through so THIS byte is handled normally — including the case
          // where it is itself another prefix.
        }

        if (code === DETACH_PREFIX_BYTE) {
          prefixPending = true;
          continue;
        }
        out += String.fromCharCode(code);
      }

      if (out) opts.emit(out);
    },
    dispose() {
      prefixPending = false;
    },
  };
}
