/**
 * The detach escape sequence.
 *
 * The assertion that matters most is the one about Ctrl+C: a naive fix for
 * "Ctrl+C cannot quit the daemon" is to route Ctrl+C to the daemon, which would
 * take away the operator's ability to interrupt a runaway agent — trading a
 * missing key for a broken one. That must stay red if anyone tries it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDetachSequenceFilter,
  DETACH_PREFIX_BYTE,
  DETACH_SUFFIX_BYTE,
} from './detach-sequence.js';

const CTRL_P = String.fromCharCode(DETACH_PREFIX_BYTE);
const CTRL_Q = String.fromCharCode(DETACH_SUFFIX_BYTE);
const CTRL_C = '\x03';

function harness() {
  const emitted: string[] = [];
  let detachCount = 0;
  const filter = createDetachSequenceFilter({
    emit: (d) => emitted.push(d),
    onDetach: () => { detachCount++; },
  });
  return {
    filter,
    get text() { return emitted.join(''); },
    get detaches() { return detachCount; },
  };
}

describe('detach sequence', () => {
  it('detaches on Ctrl-P Ctrl-Q, and neither byte reaches the agent', () => {
    const h = harness();
    h.filter.push(CTRL_P);
    h.filter.push(CTRL_Q);
    assert.equal(h.detaches, 1);
    assert.equal(h.text, '', 'the sequence is consumed, not forwarded');
  });

  it('works when both bytes arrive in ONE chunk', () => {
    // Nothing guarantees one keypress per chunk, so the split must not matter.
    const h = harness();
    h.filter.push(CTRL_P + CTRL_Q);
    assert.equal(h.detaches, 1);
    assert.equal(h.text, '');
  });

  it('⚠️ Ctrl+C still reaches the AGENT — the whole point of not stealing it', () => {
    const h = harness();
    h.filter.push(CTRL_C);
    assert.equal(h.text, CTRL_C);
    assert.equal(h.detaches, 0, 'Ctrl+C must never detach the daemon');
  });

  it('forwards BOTH bytes when Ctrl-P is followed by something else', () => {
    // Swallowing a lone Ctrl-P would break history navigation in agents that
    // use it — the same class of silently-broken-key bug being fixed here.
    const h = harness();
    h.filter.push(CTRL_P);
    h.filter.push('x');
    assert.equal(h.text, CTRL_P + 'x');
    assert.equal(h.detaches, 0);
  });

  it('handles a repeated Ctrl-P — each is flushed by the one after it', () => {
    const h = harness();
    h.filter.push(CTRL_P);
    h.filter.push(CTRL_P);
    h.filter.push(CTRL_P);
    // The third is still held, waiting to learn what it means.
    assert.equal(h.text, CTRL_P + CTRL_P);
    assert.equal(h.detaches, 0);
  });

  it('holds a lone Ctrl-P INDEFINITELY rather than putting detach on a stopwatch', () => {
    // An earlier version released it after 250ms so it would not lag. That made
    // the only keyboard stop path depend on typing speed: a slow two-chord
    // sequence forwarded the prefix and silently failed to detach. The trade is
    // deliberate — a stop key that always works beats a history key that is
    // never late.
    const h = harness();
    h.filter.push(CTRL_P);
    assert.equal(h.text, '', 'held, however long it takes');

    // ...and an arbitrarily late suffix still detaches.
    h.filter.push(CTRL_Q);
    assert.equal(h.detaches, 1);
    assert.equal(h.text, '', 'the sequence is still consumed, not forwarded');
  });

  it('preserves surrounding text and its order', () => {
    const h = harness();
    h.filter.push('abc' + CTRL_P + 'def');
    assert.equal(h.text, 'abc' + CTRL_P + 'def');
    assert.equal(h.detaches, 0);
  });

  it('emits text typed BEFORE the sequence, then detaches', () => {
    const h = harness();
    h.filter.push('ls' + CTRL_P + CTRL_Q);
    assert.equal(h.text, 'ls');
    assert.equal(h.detaches, 1);
  });

  it('detaches exactly ONCE and forwards nothing afterwards', () => {
    // Further keystrokes belong to a session that is going away; forwarding
    // them would race the teardown.
    const h = harness();
    h.filter.push(CTRL_P + CTRL_Q);
    h.filter.push('more typing');
    h.filter.push(CTRL_P + CTRL_Q);
    assert.equal(h.detaches, 1);
    assert.equal(h.text, '');
  });

  it('does not detach on Ctrl-Q alone — a lone Ctrl-Q is the agent\'s', () => {
    const h = harness();
    h.filter.push(CTRL_Q);
    assert.equal(h.detaches, 0);
    assert.equal(h.text, CTRL_Q);
  });

  it('does not detach when the two bytes are separated by another key', () => {
    const h = harness();
    h.filter.push(CTRL_P + 'x' + CTRL_Q);
    assert.equal(h.detaches, 0);
    assert.equal(h.text, CTRL_P + 'x' + CTRL_Q);
  });

  it('drops a held prefix on dispose without detaching', () => {
    const h = harness();
    h.filter.push(CTRL_P);
    h.filter.dispose();
    assert.equal(h.detaches, 0);
  });
});
