import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EvidencePorts } from '@momonga/memory';
import type { MemoryEvidence } from '@momonga/protocol';
import { MEMORY_SEARCH_TOOL_NAME } from '@momonga/tools';
import type { RuntimeStore } from '@momonga/store';
import { harness, makeStoreDir, newSession } from '../../../store/test/helpers.ts';
import { createMemoryPort } from '../../src/process/memory-port.ts';
import { createRecordViews } from '../../src/memory/views.ts';
import { SIGNAL } from './recall-fixture.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

const SHA = 'a'.repeat(40);

const FILE_SHA = 'b'.repeat(64);

const portsWhere = (ancestor: boolean): EvidencePorts => ({
  hashFile: async () => FILE_SHA,
  isAncestor: async () => ancestor,
});

const setup = async (evidence: (folderA: string) => MemoryEvidence[] = () => [{ kind: 'commit', sha: SHA }]) => {
  const { store } = harness();
  const folderA = fs.realpathSync.native(makeStoreDir());
  const folderB = fs.realpathSync.native(makeStoreDir());
  await store.trust.setAsked(folderA, 'trusted', NEVER_CANCELLED);
  await store.trust.setAsked(folderB, 'trusted', NEVER_CANCELLED);
  const note = store.memories.addByCommand({
    scope: 'user',
    project: null,
    text: 'the parser note',
    evidence: evidence(folderA),
  });
  return { store, note, folderA, folderB };
};

const statusSeenFrom = async (store: RuntimeStore, folder: string, ancestor: boolean): Promise<string> => {
  const port = createMemoryPort({
    store,
    settings: {
      trusted: () => true,
      verification: async () => ({ commands: [] }),
    } as never,
    evidenceRun: () => async () => ({ exitCode: 128 }),
    evidencePorts: () => portsWhere(ancestor),
  });
  const set = await port.load(newSession(store, folder), SIGNAL);
  const tool = set.tools.find((candidate) => candidate.name === MEMORY_SEARCH_TOOL_NAME);
  if (tool === undefined) throw new Error('MemorySearch is not offered');
  const result = (await tool.execute({ query: 'parser' } as never, { signal: SIGNAL } as never, undefined)) as { output: string };
  const status = /status (\w+)/.exec(result.output)?.[1];
  if (status === undefined) throw new Error(`no status in ${result.output}`);
  return status;
};

describe('one rule decides which folder a note is checked against', () => {
  it('gives a user note the same status from every viewer and appends no observation for a change of viewer', async () => {
    const { store, note, folderA, folderB } = await setup();
    const fromA = await statusSeenFrom(store, folderA, true);
    const fromB = await statusSeenFrom(store, folderB, false);
    const views = createRecordViews({
      store,
      evidenceRun: () => async () => ({ exitCode: 128 }),
      evidencePorts: () => portsWhere(true),
    });
    const fromService = (await views.viewOf(note, SIGNAL)).status;
    expect([fromA, fromB]).toEqual([fromService, fromService]);
    expect(store.memories.observations(note.id)).toHaveLength(1);
  });

  it('checks a user note bound to a file of folder A against folder A from every viewer', async () => {
    const { store, note, folderA, folderB } = await setup((folder) => [{ kind: 'file', project: folder, path: 'src/a.ts', sha256: FILE_SHA }]);
    const fromA = await statusSeenFrom(store, folderA, true);
    const fromB = await statusSeenFrom(store, folderB, true);
    const views = createRecordViews({ store, evidenceRun: () => async () => ({ exitCode: 128 }), evidencePorts: () => portsWhere(true) });
    expect([fromA, fromB]).toEqual([(await views.viewOf(note, SIGNAL)).status, 'verified']);
    expect(store.memories.observations(note.id)).toHaveLength(1);
  });
});
