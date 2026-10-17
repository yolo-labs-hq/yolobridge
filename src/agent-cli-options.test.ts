import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAgentCliOptions, composeAgentArgv } from './agent-cli-options.js';
import { parseAttachArgs } from './cli.js';

describe('interactive agent CLI options', () => {
  it('splits Bridge flags from agent argv without tokenizing values', () => {
    const result = parseAttachArgs(['w1','--agent','claude','--label','laptop','--','--model','sonnet','--resume','session with spaces']);
    assert.ok(!('error' in result));
    assert.equal(result.workspaceId,'w1');
    assert.equal(result.hostLabel,'laptop');
    assert.deepEqual(result.agentArgs,['--model','sonnet','--resume','session with spaces']);
  });
  it('does not treat agent arguments as the workspace or Bridge flags', () => {
    const result = parseAttachArgs(['--agent','claude','--','--model','sonnet']);
    assert.ok(!('error' in result)); assert.equal(result.workspaceId,undefined);
    const unsupported = parseAttachArgs(['--','--label','wrong']);
    assert.ok(!('error' in unsupported));
    assert.ok(validateAgentCliOptions('claude',unsupported.agentArgs!));
  });
  it('supports ordinary Claude model and interactive resume/continue forms', () => {
    for(const args of [['--model','sonnet'],['--model=sonnet','--resume','a session'],['--resume'],['-r','id'],['--continue'],['-c'],[]]) assert.equal(validateAgentCliOptions('claude',args),undefined);
    for(const args of [['--model'],['--model='],['--resume='],['--continue','--resume'],['--resume','--resume']]) assert.ok(validateAgentCliOptions('claude',args));
  });
  it('supports Codex model selection and resume with ID, picker or last', () => {
    for(const args of [['--model','a-model'],['-m','a-model','resume','a session'],['resume','--last'],['resume'],['resume','id','--model=a-model']]) assert.equal(validateAgentCliOptions('codex',args),undefined);
    for(const args of [['--last'],['resume','id','--last'],['resume','--last','--last'],['exec','prompt']]) assert.ok(validateAgentCliOptions('codex',args));
  });
  it('rejects unimplemented agent options, permission/config changes and positional prompts', () => {
    for(const agent of ['claude','codex']) {
      for(const args of [['--unknown'],['--dangerously-skip-permissions'],['--permission-mode','bypassPermissions'],['--config','approval_policy="never"'],['--mcp-config','{}'],['--model','--unknown'],['a prompt'],['--model','bad\nmodel']]) assert.ok(validateAgentCliOptions(agent,args));
    }
    assert.equal(validateAgentCliOptions('other',[]),undefined);
    assert.ok(validateAgentCliOptions('other',['--model','a-model']));
  });
  it('rejects unsupported options through the real CLI before login or network attachment', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'attach', 'workspace', '--agent', 'claude', '--', '--unknown'], {encoding: 'utf8', timeout: 5000, env: {...process.env, YOLOBRIDGE_API_URL: 'http://127.0.0.1:1'}});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /Unsupported agent option/);
    assert.doesNotMatch(result.stderr, /not logged in|unexpected error/);
  });
  it('appends distinct literal argv entries after Bridge MCP configuration', () => {
    const mcp = ['--mcp-config','{"mcpServers":{}}'];
    const user = ['--model','sonnet','--resume','name; $(printf no-shell)'];
    assert.equal(validateAgentCliOptions('claude',user),undefined);
    const combined=composeAgentArgv(mcp,user);
    assert.deepEqual(combined,[...mcp,...user]);
    combined.push('extra'); assert.equal(mcp.length,2); assert.equal(user.length,4);
  });
});
