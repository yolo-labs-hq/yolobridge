import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveAgentBinary, tokenizeShebang, envInvocation, type BinaryProbeFs } from './resolve-agent-binary.js';

/**
 * A fake filesystem. `files` maps an absolute path to its kind; `shebangs`
 * gives a path's first line, so a script with a missing interpreter can be
 * modelled without touching the real disk.
 */
function fakeFs(
  files: Record<string, 'exec' | 'noexec' | 'dir'>,
  shebangs: Record<string, string> = {},
): BinaryProbeFs {
  return {
    readFirstLine: (p: string) => shebangs[p] ?? null,
    statSync(p: string) {
      const kind = files[p];
      if (!kind) throw new Error('ENOENT');
      return { isFile: () => kind !== 'dir', isDirectory: () => kind === 'dir' };
    },
    accessSync(p: string) {
      if (files[p] !== 'exec') throw new Error('EACCES');
    },
    constants: { X_OK: 1 },
  };
}

const PATH_ENV = { PATH: ['/usr/bin', '/opt/homebrew/bin', '/Users/j/.local/bin'].join(path.delimiter) };

describe('finding the agent binary', () => {
  it('returns the first PATH hit, in PATH order', () => {
    const io = fakeFs({ '/opt/homebrew/bin/claude': 'exec', '/Users/j/.local/bin/claude': 'exec' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.path, '/opt/homebrew/bin/claude');
  });

  it('takes an explicit path at its word, without searching PATH', () => {
    const io = fakeFs({ [path.resolve('/custom/claude')]: 'exec' });
    const r = resolveAgentBinary('/custom/claude', { PATH: '' }, io);
    assert.equal(r.ok, true);
  });
});

describe('the message an operator actually reads', () => {
  it('names the MISSING BINARY, not just that something failed', () => {
    // The whole point: node-pty says only `posix_spawnp failed.`
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'not-found');
    assert.match(r.ok === false ? r.message : '', /claude/);
  });

  it('warns that a shell alias or function is not spawnable', () => {
    // ⚠️ The macOS trap. `claude` working when typed argues nothing is wrong,
    // so a bare "not found" gets answered with "but it IS installed".
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.match(r.ok === false ? r.message : '', /alias or function/);
    assert.match(r.ok === false ? r.message : '', /type -a claude/);
  });

  it('offers the escape hatch when it cannot be found', () => {
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.match(r.ok === false ? r.message : '', /--agent/);
    assert.match(r.ok === false ? r.message : '', /YOLOBRIDGE_AGENT_BIN/);
  });

  it('distinguishes NOT EXECUTABLE from missing, and says chmod', () => {
    // A different fault with a different fix — collapsing them into "not
    // found" sends the operator to reinstall something already present.
    const io = fakeFs({ '/opt/homebrew/bin/claude': 'noexec' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok === false && r.reason, 'not-executable');
    assert.match(r.ok === false ? r.message : '', /chmod \+x/);
    assert.match(r.ok === false ? r.message : '', /opt\/homebrew\/bin\/claude/);
  });

  it('reports an EMPTY PATH as its own fault, not as "not found"', () => {
    const r = resolveAgentBinary('claude', { PATH: '' }, fakeFs({}));
    assert.equal(r.ok === false && r.reason, 'no-path');
    assert.match(r.ok === false ? r.message : '', /PATH is empty/);
  });

  it('says how many directories it searched, so "it IS installed" is checkable', () => {
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.match(r.ok === false ? r.message : '', /searched 3 directories/);
  });
});

describe('a script whose INTERPRETER is the missing piece', () => {
  // ⚠️ The case every other check passes. The file is on PATH, is a real file,
  // and is +x — and the spawn still fails ENOENT, because the kernel reports
  // the absent INTERPRETER indistinguishably from the script being absent.
  // This is the macOS report this was written for: `type -a claude` listed two
  // real installs while node-pty said only `posix_spawnp failed.`

  it('is caught even though the script itself is present and executable', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec' },
      { '/usr/bin/claude': '#!/Users/j/.nvm/versions/node/v22.21.1/bin/node' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'bad-interpreter');
  });

  it('names the INTERPRETER, not just the script', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec' },
      { '/usr/bin/claude': '#!/missing/node' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.match(r.ok === false ? r.message : '', /\/missing\/node/);
    assert.match(r.ok === false ? r.message : '', /interpreter/);
  });

  it('accepts the script when its interpreter DOES exist', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/node' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, true);
  });

  it('follows `#!/usr/bin/env node` back through PATH rather than taking it literally', () => {
    // `env` delegates the search to PATH, so the thing to verify is `node`,
    // not a file literally called `/usr/bin/env node`.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env node' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'bad-interpreter');
    assert.match(r.ok === false ? r.message : '', /node/);
  });

  it('accepts `#!/usr/bin/env node` when node IS on PATH', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env node' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('treats a real binary (no shebang) as fine', () => {
    const io = fakeFs({ '/usr/bin/claude': 'exec' }, {});
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('fails on a missing `env` ITSELF, even when its command is available', () => {
    // ⚠️ The kernel execs the interpreter. `#!/missing/env node` cannot spawn
    // however available `node` is, so delegating straight to env's argument
    // would hand back a clean bill of health for a broken script.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/missing/env node' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.message : '', /\/missing\/env/);
  });

  it('reads the command past `-u NAME`, which CONSUMES its operand', () => {
    // The naive "first token without a dash" rule picks NODE_OPTIONS here and
    // rejects a working agent.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env -u NODE_OPTIONS node' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('reads the command past a NAME=VALUE assignment', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env NODE_ENV=production node' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('reads the command past `-S`, which splits the rest', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env -S node --enable-source-maps' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('still catches a genuinely missing command behind those options', () => {
    // The regression that would make the parsing fix a silent no-op.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env -u NODE_OPTIONS node' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.message : '', /node/);
  });

  it('honours QUOTED values when splitting the shebang', () => {
    // ⚠️ `-S NODE_OPTIONS="--require /tmp/h.js" node` is spawnable. Splitting
    // on raw whitespace picks `/tmp/h.js"` as the command and declares a
    // working agent broken — worse than the silence this replaces.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env -S NODE_OPTIONS="--require /tmp/h.js" node' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('blames the file that is ACTUALLY missing in a nested chain', () => {
    // claude -> /usr/bin/node (exists, but is itself a script) -> /missing/runtime.
    // Reporting "/usr/bin/node cannot be found" would be a claim about a file
    // sitting right there, which is the misdirection this check exists to end.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/node', '/usr/bin/node': '#!/missing/runtime' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    const msg = r.ok === false ? r.message : '';
    assert.match(msg, /\/missing\/runtime/);
    assert.doesNotMatch(msg, /`\/usr\/bin\/node` cannot be found/);
  });

  it('does not loop forever on a self-referential interpreter chain', () => {
    const io = fakeFs(
      { '/usr/bin/claude': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/claude' },
    );
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.ok(r.ok === true || r.ok === false);  // terminates, either verdict
  });
});

describe('the environment `env` builds before it looks anything up', () => {
  it('finds the command in a PATH the shebang ASSIGNS, not the daemon\'s', () => {
    // ⚠️ env constructs the environment first and resolves second. Using the
    // daemon's PATH here rejects an agent whose runtime lives only in the
    // assigned path.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/runtime/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env PATH=/opt/runtime/bin node' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, true);
  });

  it('does NOT find it when the assigned PATH does not contain it', () => {
    // The mirror: an agent that will fail the moment env replaces PATH must
    // not be waved through just because the daemon's own PATH has a node.
    const io = fakeFs(
      { '/usr/bin/claude': 'exec', '/usr/bin/env': 'exec', '/opt/homebrew/bin/node': 'exec' },
      { '/usr/bin/claude': '#!/usr/bin/env PATH=/opt/runtime/bin node' },
    );
    assert.equal(resolveAgentBinary('claude', PATH_ENV, io).ok, false);
  });

  it('applies an assignment to the environment it returns', () => {
    const r = envInvocation(['PATH=/opt/runtime/bin', 'node'], { PATH: '/usr/bin' });
    assert.equal(r.command, 'node');
    assert.equal(r.env.PATH, '/opt/runtime/bin');
  });

  it('honours -u by unsetting, and -i by starting empty', () => {
    assert.equal(envInvocation(['-u', 'PATH', 'node'], { PATH: '/usr/bin' }).env.PATH, undefined);
    assert.equal(envInvocation(['-uPATH', 'node'], { PATH: '/usr/bin' }).env.PATH, undefined);
    assert.equal(envInvocation(['-i', 'node'], { PATH: '/usr/bin' }).env.PATH, undefined);
  });

  it('leaves the base environment untouched', () => {
    // A resolver that mutated its caller's env would leak a shebang's
    // assignments into every later lookup.
    const base = { PATH: '/usr/bin' };
    envInvocation(['PATH=/other', 'node'], base);
    assert.equal(base.PATH, '/usr/bin');
  });
});

describe('splitting a shebang line', () => {
  it('splits on whitespace in the ordinary case', () => {
    assert.deepEqual(tokenizeShebang('/usr/bin/env node'), ['/usr/bin/env', 'node']);
  });

  it('keeps a double-quoted value together', () => {
    assert.deepEqual(
      tokenizeShebang('/usr/bin/env -S NODE_OPTIONS="--require /tmp/h.js" node'),
      ['/usr/bin/env', '-S', 'NODE_OPTIONS=--require /tmp/h.js', 'node'],
    );
  });

  it('keeps a single-quoted value together and does not expand escapes inside it', () => {
    assert.deepEqual(tokenizeShebang("/bin/sh -c 'a\\ b'"), ['/bin/sh', '-c', 'a\\ b']);
  });

  it('honours a backslash-escaped space in a path', () => {
    assert.deepEqual(tokenizeShebang('/opt/my\\ tools/node'), ['/opt/my tools/node']);
  });

  it('collapses runs of whitespace rather than emitting empty tokens', () => {
    assert.deepEqual(tokenizeShebang('  /usr/bin/env   node  '), ['/usr/bin/env', 'node']);
  });

  it('preserves a deliberately empty quoted argument', () => {
    assert.deepEqual(tokenizeShebang('/usr/bin/env FOO= node'), ['/usr/bin/env', 'FOO=', 'node']);
  });
});

describe('things that must not be mistaken for a binary', () => {
  it('does not accept a DIRECTORY named like the binary', () => {
    const io = fakeFs({ '/usr/bin/claude': 'dir' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'not-found');
  });

  it('skips a non-executable hit and keeps searching for a real one', () => {
    // PATH order matters: an earlier unusable entry must not mask a later
    // working install, or the operator is told to chmod something irrelevant.
    const io = fakeFs({ '/usr/bin/claude': 'noexec', '/opt/homebrew/bin/claude': 'exec' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.path, '/opt/homebrew/bin/claude');
  });

  it('ignores empty PATH segments rather than probing the cwd', () => {
    // A trailing ':' means "current directory" to some shells; spawning a
    // binary from wherever the operator happens to be is not a behaviour to
    // inherit by accident.
    const io = fakeFs({ [path.join('', 'claude')]: 'exec' });
    const r = resolveAgentBinary('claude', { PATH: '/usr/bin:' }, io);
    assert.equal(r.ok, false);
  });
});
