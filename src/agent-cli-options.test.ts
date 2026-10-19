import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeAgentArgv } from './agent-cli-options.js';
import { parseAttachArgs } from './cli.js';

describe('interactive agent CLI options', () => {
  it('splits Bridge flags from agent argv without tokenizing values', () => {
    const result = parseAttachArgs(['w1','--agent','claude','--label','laptop','--','--model','sonnet','--resume','session with spaces']);
    assert.ok(!('error' in result));
    assert.equal(result.workspaceId,'w1');
    assert.equal(result.hostLabel,'laptop');
    assert.deepEqual(result.agentArgs,['--model','sonnet','--resume','session with spaces']);
  });
  it('does not treat arguments after -- as workspace or Bridge flags', () => {
    const result = parseAttachArgs(['--agent','claude','--','--model','sonnet']);
    assert.ok(!('error' in result)); assert.equal(result.workspaceId,undefined);
    const forwarded = parseAttachArgs(['--','--label','not-a-bridge-label']);
    assert.ok(!('error' in forwarded));
    assert.deepEqual(forwarded.agentArgs, ['--label','not-a-bridge-label']);
  });
  it('forwards arbitrary arguments after -- as distinct literal argv entries', () => {
    const mcp = ['--mcp-config','{"mcpServers":{}}'];
    const user = ['--dangerously-skip-permissions','--permission-mode','bypassPermissions','--config','approval_policy="never"','a prompt','name; $(printf no-shell)'];
    const combined=composeAgentArgv(mcp,user);
    assert.deepEqual(combined,[...mcp,...user]);
    combined.push('extra'); assert.equal(mcp.length,2); assert.equal(user.length,7);
  });
});
