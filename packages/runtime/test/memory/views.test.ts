import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '@momonga/protocol';
import { createRecordViews } from '../../src/memory/views.ts';
import type { EvidenceCommand } from '../../src/memory/evidence.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const record = (id: string, project: string, sha = SHA): MemoryRecord => ({
  id,
  scope: 'project',
  origin: 'trusted',
  project,
  text: `note ${id}`,
  source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: id, seq: 1 },
  createdAt: 0,
  keptAt: 0,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [{ kind: 'commit', sha }],
  contributedAt: null,
  observedStatus: null,
});

const viewsWith = (exitCode: number | null) => {
  const commands: { project: string; command: EvidenceCommand; signal: AbortSignal }[] = [];
  const views = createRecordViews({
    store: { trust: { decisionFor: () => ({ decision: 'trusted' }) }, memories: { observe: () => false } } as never,
    evidenceRun: (project) => async (command, signal) => {
      commands.push({ project, command, signal });
      return { exitCode };
    },
  });
  return { views, commands };
};

describe('record views', () => {
  it('starts one process per distinct sha and project for the whole read, however many memories carry it', async () => {
    const { views, commands } = viewsWith(0);
    const other = 'f'.repeat(40);
    const found = await views.viewsOf(
      [record('a', '/p'), record('b', '/p'), record('c', '/p', other), record('d', '/q'), record('e', '/p')],
      new AbortController().signal,
    );
    expect(found.map((view) => view.status)).toEqual(['unbound', 'unbound', 'unbound', 'unbound', 'unbound']);
    expect(commands.map((entry) => `${entry.project} ${entry.command.argv[3]}`).sort()).toEqual([`/p ${SHA}`, `/p ${other}`, `/q ${SHA}`].sort());
  });

  it('hands the signal of the read to every process, and starts none once it has aborted', async () => {
    const { views, commands } = viewsWith(0);
    const live = new AbortController();
    await views.viewOf(record('a', '/p'), live.signal);
    expect(commands.map((entry) => entry.signal)).toEqual([live.signal]);
    const stopped = new AbortController();
    stopped.abort();
    const result = await views.viewOf(record('b', '/p'), stopped.signal);
    expect(result.status).toBe('unverifiable');
    expect(commands).toHaveLength(1);
  });

  it('asks again in the next read', async () => {
    const { views, commands } = viewsWith(0);
    await views.viewOf(record('a', '/p'), new AbortController().signal);
    await views.viewOf(record('a', '/p'), new AbortController().signal);
    expect(commands).toHaveLength(2);
  });
});
