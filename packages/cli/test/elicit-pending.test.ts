import { describe, expect, it } from 'vitest';
import type { ElicitationView, RunView } from '../src/client/views.ts';
import { pendingElicitationsOf } from '../src/commands/elicit.ts';
import { runView } from './fake-backend.ts';

const elicitation = (id: string, runId: string, status: ElicitationView['status']): ElicitationView => ({
  id,
  runId,
  callId: 'call-1',
  status,
  server: 'remote',
  requests: [],
  expiresAt: 10,
  createdAt: 1,
  toolCall: { callId: 'call-1', name: 'mcp__remote__ask', title: 'Ask' },
});

describe('pendingElicitationsOf', () => {
  it('lists the pending questions of the run and of the subagent runs beneath it', async () => {
    const runs: Record<string, RunView> = { parent: runView({ id: 'parent' }), child: runView({ id: 'child', parentRunId: 'parent' }), grandchild: runView({ id: 'grandchild', parentRunId: 'child' }) };
    const children: Record<string, string[]> = { parent: ['child'], child: ['grandchild'], grandchild: [] };
    const questions: Record<string, ElicitationView[]> = {
      parent: [elicitation('in-0', 'parent', 'resolved')],
      child: [elicitation('in-1', 'child', 'pending')],
      grandchild: [elicitation('in-2', 'grandchild', 'pending')],
    };
    const client = {
      getRun: async (id: string) => runs[id] as RunView,
      childRuns: async (id: string) => (children[id] ?? []).map((child) => runs[child] as RunView),
      elicitations: async (id: string) => questions[id] ?? [],
    };

    expect((await pendingElicitationsOf(client, 'parent')).map((view) => view.id)).toEqual(['in-1', 'in-2']);
  });
});
