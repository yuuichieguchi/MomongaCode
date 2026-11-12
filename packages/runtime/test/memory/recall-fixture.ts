import fs from 'node:fs';
import { StatementSync } from 'node:sqlite';
import { vi } from 'vitest';
import type { EvidencePorts } from '@momonga/memory';
import type { MemoryRecord } from '@momonga/protocol';
import type { RuntimeStore, Session } from '@momonga/store';
import { harness, makeStoreDir, newSession, rawDb } from '../../../store/test/helpers.ts';
import { createMemoryPort } from '../../src/process/memory-port.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

export const RECORDED_SHA = 'c'.repeat(64);

export type CheckCounter = { calls: number; inFlight: number; maxInFlight: number; paths: string[] };

export const newCounter = (): CheckCounter => ({ calls: 0, inFlight: 0, maxInFlight: 0, paths: [] });

export const countingPorts = (counter: CheckCounter): EvidencePorts => ({
  hashFile: async (absolutePath) => {
    counter.calls += 1;
    counter.paths.push(absolutePath);
    counter.inFlight += 1;
    counter.maxInFlight = Math.max(counter.maxInFlight, counter.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    counter.inFlight -= 1;
    return RECORDED_SHA;
  },
  isAncestor: async () => undefined,
});

export const SETTINGS = { trusted: () => true, verification: async () => ({ commands: [], conditions: [] }) } as never;

export const portFor = (store: RuntimeStore, counter: CheckCounter) =>
  createMemoryPort({
    platform: process.platform,
    store,
    settings: SETTINGS,
    evidenceRun: () => async () => ({ exitCode: 128 }),
    evidencePorts: () => countingPorts(counter),
  });

export type Seeded = { store: RuntimeStore; session: Session; project: string; dbPath: string; template: MemoryRecord };

export const seededStore = async (count: number, text: (index: number) => string): Promise<Seeded> => {
  const { store, dbPath } = harness();
  const project = fs.realpathSync.native(makeStoreDir());
  await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
  const session = newSession(store, project);
  const template = store.memories.addByCommand({
    scope: 'project',
    project,
    text: text(0),
    evidence: [{ kind: 'file', project, path: 'src/bound.ts', sha256: RECORDED_SHA }],
  });
  if (count > 1) copyNotes(dbPath, template.id, count - 1, text);
  return { store, session, project, dbPath, template };
};

const copyNotes = (dbPath: string, templateId: string, copies: number, text: (index: number) => string): void => {
  const db = rawDb(dbPath);
  db.exec('BEGIN IMMEDIATE');
  db.exec('CREATE TEMP TABLE copy_numbers (k INTEGER PRIMARY KEY)');
  db.prepare('WITH RECURSIVE c(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM c WHERE k < ?) INSERT INTO copy_numbers SELECT k FROM c').run(copies);
  db.prepare('CREATE TEMP TABLE note_copies AS SELECT memories.*, copy_numbers.k AS copy_k FROM memories, copy_numbers WHERE memories.id = ?').run(templateId);
  db.exec("UPDATE note_copies SET id = printf('%s-%08d', id, copy_k)");
  db.exec('CREATE INDEX note_copies_by_k ON note_copies (copy_k)');
  const setText = db.prepare('UPDATE note_copies SET text = ? WHERE copy_k = ?');
  for (let index = 1; index <= copies; index += 1) setText.run(text(index), index);
  db.exec('DROP INDEX note_copies_by_k');
  db.exec('ALTER TABLE note_copies DROP COLUMN copy_k');
  db.exec('INSERT INTO memories SELECT * FROM note_copies');
  db.prepare('CREATE TEMP TABLE evidence_copies AS SELECT memory_evidence.*, copy_numbers.k AS copy_k FROM memory_evidence, copy_numbers WHERE memory_evidence.memory_id = ?').run(templateId);
  db.exec("UPDATE evidence_copies SET memory_id = printf('%s-%08d', memory_id, copy_k)");
  db.exec('ALTER TABLE evidence_copies DROP COLUMN copy_k');
  db.exec('INSERT INTO memory_evidence SELECT * FROM evidence_copies');
  db.exec('COMMIT');
  db.close();
};

const STATEMENT_METHODS = ['all', 'get', 'run', 'iterate'] as const;

export const countStatements = async <T>(action: () => Promise<T>): Promise<{ result: T; statements: number }> => {
  const spies = STATEMENT_METHODS.map((method) => vi.spyOn(StatementSync.prototype, method));
  try {
    const result = await action();
    return { result, statements: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

export const SIGNAL = new AbortController().signal;
