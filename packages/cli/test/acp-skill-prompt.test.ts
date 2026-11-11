import { describe, expect, it } from 'vitest';
import { SESSION, runView } from './fake-backend.ts';
import { INITIALIZE, resultOf, startAgent } from './acp-harness.ts';

const SKILLS = { skills: [{ name: 'pdf', description: 'Extract PDF text', scope: 'project' as const, location: '/w/SKILL.md' }], warnings: [] };

describe('a prompt that names a skill before the skills of the session were announced', () => {
  it('uses the skill when it follows session/new at once', async () => {
    const harness = startAgent();
    harness.runtime.skillList = SKILLS;
    harness.scripts.set('run-1', async () => runView({ id: 'run-1', status: 'COMPLETED' }));
    await harness.peer.request('initialize', INITIALIZE);

    const creating = harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [] });
    const { sessionId } = resultOf(await creating) as { sessionId: string };
    const answered = await harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/pdf summarize it' }] });

    expect(resultOf(answered)).toEqual({ stopReason: 'end_turn' });
    expect(harness.runtime.calls.filter((call) => call.startsWith('createRun'))).toEqual([`createRun ${sessionId} ${JSON.stringify({ input: 'summarize it', skill: 'pdf' })}`]);
    await harness.peer.close();
  });

  it('reads the skills of a session once for the announcement and the prompt', async () => {
    const harness = startAgent();
    harness.runtime.skillList = SKILLS;
    harness.scripts.set('run-1', async () => runView({ id: 'run-1', status: 'COMPLETED' }));
    await harness.peer.request('initialize', INITIALIZE);
    const { sessionId } = resultOf(await harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [] })) as { sessionId: string };

    await harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/pdf summarize it' }] });

    expect(harness.runtime.calls.filter((call) => call.startsWith('skills'))).toHaveLength(1);
    await harness.peer.close();
  });

  it('uses the skill when it follows session/load at once', async () => {
    const harness = startAgent();
    harness.runtime.skillList = SKILLS;
    harness.scripts.set('run-1', async () => runView({ id: 'run-1', status: 'COMPLETED' }));
    await harness.peer.request('initialize', INITIALIZE);

    await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });
    await harness.peer.request('session/prompt', { sessionId: SESSION.id, prompt: [{ type: 'text', text: '/pdf summarize it' }] });

    expect(harness.runtime.calls.filter((call) => call.startsWith('createRun'))).toEqual([`createRun ${SESSION.id} ${JSON.stringify({ input: 'summarize it', skill: 'pdf' })}`]);
    await harness.peer.close();
  });
});
