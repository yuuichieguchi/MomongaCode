import { describe, expect, it } from 'vitest';
import { agentWarningSource, mcpWarningSource, skillWarningSource, updateNoticeSource } from '../src/tui/notices.ts';
import { fakeRuntime } from './acp-harness.ts';
import { setupUpdate } from './update-harness.ts';

describe('startup notice sources', () => {
  it('reads the agent warnings of the session from the Run API', async () => {
    const runtime = fakeRuntime();
    runtime.agents = async (sessionId) => {
      expect(sessionId).toBe(runtime.session.id);
      return { agents: [], warnings: ['Project agents in /p/.momonga/agents were skipped because the folder is not trusted'] };
    };

    expect(await agentWarningSource({ runtime, session: runtime.session })).toEqual(['Project agents in /p/.momonga/agents were skipped because the folder is not trusted']);
  });

  it('reads the skill warnings of the session from the Run API', async () => {
    const runtime = fakeRuntime();
    runtime.skillList = { skills: [], warnings: ['Project skills were skipped because the folder is not trusted'] };

    expect(await skillWarningSource({ runtime, session: runtime.session })).toEqual(['Project skills were skipped because the folder is not trusted']);
  });

  it('reads the load warnings of the session MCP servers from the Run API', async () => {
    const runtime = fakeRuntime();
    runtime.mcpWarnings = async (sessionId) => {
      expect(sessionId).toBe(runtime.session.id);
      return ['The address of remote is plain http to another computer: what you send to it is not encrypted.'];
    };

    expect(await mcpWarningSource({ runtime, session: runtime.session })).toEqual([
      'The address of remote is plain http to another computer: what you send to it is not encrypted.',
    ]);
  });

  it('shows an update result once and marks it announced', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };
    const runtime = fakeRuntime();
    const source = updateNoticeSource(harness.wiring);

    expect(await source({ runtime, session: runtime.session })).toEqual(['momonga: momonga 2.0.0 was installed in the background; you are running 1.0.0']);
    expect(await source({ runtime, session: runtime.session })).toEqual([]);
  });
});
