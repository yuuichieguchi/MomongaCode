import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryEvidence, MemoryScope } from '@momonga/protocol';
import { MEMORY_SAVE_TOOL_NAME } from '@momonga/tools';
import type { EvidenceReply, RuntimeStore } from '@momonga/store';
import { callEvent, enqueue, harness, makeStoreDir, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { createMemoryPort } from '../../src/process/memory-port.ts';
import { prepareCommandMemory } from '../../src/memory/add-memory.ts';
import type { EvidenceRun } from '../../src/memory/evidence.ts';
import { SIGNAL } from './recall-fixture.ts';

const HEAD = 'd'.repeat(40);
const RECORDED = 'e'.repeat(64);

const gitAnsweringHead: EvidenceRun = async () => ({ exitCode: 0, stdout: `${HEAD}\n` });

const trustedGitFolder = () => {
  const { store } = harness();
  const folder = fs.realpathSync.native(makeStoreDir());
  fs.mkdirSync(path.join(folder, 'src'));
  fs.writeFileSync(path.join(folder, 'src', 'a.ts'), 'export const a = 1;\n');
  store.trust.set(folder, 'trusted');
  return { store, folder };
};

const journalRecordingEveryPath = (store: RuntimeStore): RuntimeStore['journalFacts'] => ({
  ...store.journalFacts,
  evidence: async ({ paths }): Promise<EvidenceReply> => ({ lastSeq: 0, recorded: paths.map(() => ({ seq: 1, sha256: RECORDED })), check: null }),
});

const saveThroughTool = async (store: RuntimeStore, folder: string, scope: MemoryScope, paths?: string[]) => {
  const port = createMemoryPort({
    store: { memories: store.memories, trust: store.trust, journalFacts: journalRecordingEveryPath(store) },
    settings: { trusted: () => true, verification: async () => ({ commands: [] }) } as never,
    evidenceRun: () => gitAnsweringHead,
  });
  const session = newSession(store, folder);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  if (store.append(claim, [callEvent('call-1')]).kind !== 'ok') throw new Error('the tool call was not recorded');
  const set = await port.load(session, SIGNAL);
  const tool = set.tools.find((candidate) => candidate.name === MEMORY_SAVE_TOOL_NAME);
  if (tool === undefined) throw new Error('MemorySave is not offered');
  const input = { text: 'the parser keeps tokens in a flat array', scope, ...(paths === undefined ? {} : { paths }) };
  return tool.execute(input as never, { runId: run.id, step: 1, callId: 'call-1', signal: SIGNAL } as never, undefined);
};

const commandContext = (store: RuntimeStore) => ({
  trusted: (project: string) => store.trust.get(project) === 'trusted',
  evidenceRun: () => gitAnsweringHead,
  signal: SIGNAL,
});

const repositoryEvidenceOf = (evidence: readonly MemoryEvidence[]): MemoryEvidence[] =>
  evidence.filter((item) => item.kind === 'commit' || item.kind === 'file');

const savedEvidence = (store: RuntimeStore, scope: MemoryScope): MemoryEvidence[] =>
  store.memories
    .list()
    .filter((memory) => memory.scope === scope)
    .flatMap((memory) => memory.evidence);

describe('an any-project memory carries no repository evidence on any path', () => {
  it('saves a user memory through the tool in a trusted git folder with no commit and no file evidence', async () => {
    const { store, folder } = trustedGitFolder();
    await saveThroughTool(store, folder, 'user');
    const users = store.memories.list().filter((memory) => memory.scope === 'user');
    expect(users).toHaveLength(1);
    expect(repositoryEvidenceOf(savedEvidence(store, 'user'))).toEqual([]);
  });

  it('never stores file or commit evidence on a user memory saved through the tool with paths', async () => {
    const { store, folder } = trustedGitFolder();
    await saveThroughTool(store, folder, 'user', ['src/a.ts']).catch(() => undefined);
    expect(repositoryEvidenceOf(savedEvidence(store, 'user'))).toEqual([]);
  });

  it('prepares a user memory through the command with no commit and no file evidence', async () => {
    const { store } = trustedGitFolder();
    const prepared = await prepareCommandMemory({ text: 'the parser keeps tokens in a flat array', scope: 'user' }, commandContext(store));
    expect(prepared.evidence).toEqual([]);
  });
});

describe('a project memory keeps its repository evidence on every path', () => {
  it('binds the recorded file hash and the head commit through the tool', async () => {
    const { store, folder } = trustedGitFolder();
    await saveThroughTool(store, folder, 'project', ['src/a.ts']);
    expect(repositoryEvidenceOf(savedEvidence(store, 'project'))).toEqual([
      { kind: 'file', project: folder, path: 'src/a.ts', sha256: RECORDED },
      { kind: 'commit', sha: HEAD },
    ]);
  });

  it('binds the file hash and the head commit through the command', async () => {
    const { store, folder } = trustedGitFolder();
    const prepared = await prepareCommandMemory(
      { text: 'the parser keeps tokens in a flat array', scope: 'project', project: folder, paths: ['src/a.ts'] },
      commandContext(store),
    );
    const evidence = repositoryEvidenceOf(prepared.evidence);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ kind: 'file', project: folder, path: 'src/a.ts' });
    expect((evidence[0] as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence[1]).toEqual({ kind: 'commit', sha: HEAD });
  });
});
