import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import { anchorsOf, enqueue, harness, newSession, rawDb } from '../helpers.ts';
import { finishedRun, indexAll, redactor } from '../search-fixture.ts';
import { awaitingApproval } from '../approval-fixture.ts';
import { appendForeignSessionEvent, recordNewerMigration } from './fixtures.ts';

const UNKNOWN = 'from-a-newer-build';

const writeUnknown = (dbPath: string, table: string, column: string, where: string, id: string | number): void => {
  const db = rawDb(dbPath);
  db.exec('PRAGMA ignore_check_constraints = ON');
  for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table)) db.exec(`DROP TRIGGER "${String(trigger['name'])}"`);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where} = ?`).run(UNKNOWN, id);
  db.close();
};

const markNewer = (dbPath: string): void => {
  const db = rawDb(dbPath);
  recordNewerMigration(db);
  db.close();
};

const savedMemory = async () => {
  const env = harness();
  const { runId } = await awaitingApproval(env.store, [{ callId: 'c1' }], 'waiting');
  const memory = (await env.store.memories.save({
    origin: 'trusted',
    scope: 'project',
    project: '/work/a',
    text: 'tests live in test/',
    runId,
    step: 1,
    callId: 'c1',
    evidence: [{ kind: 'commit', sha: 'a'.repeat(40) }],
  })).memory;
  env.store.memories.observe(memory.id, 'verified');
  return { ...env, memory };
};

const governingFact = (enforced: boolean) => {
  const env = harness();
  const fact = env.store.governing.add({
    kind: 'constraint',
    target: 'shell',
    text: 'never push',
    scope: { level: 'project', project: '/work/a', paths: [] },
    validUntil: null,
    supersedes: [],
    enforcement: enforced ? { behavior: 'deny', rule: 'Bash(git push:*)' } : null,
    source: { kind: 'command' },
  }).fact;
  return { ...env, fact };
};

describe('memory columns this build does not know (11.4)', () => {
  it.each([
    ['scope', (memory: Record<string, unknown>) => memory['scope']],
    ['origin', (memory: Record<string, unknown>) => memory['origin']],
    ['kind', (memory: Record<string, unknown>) => memory['kind']],
    ['source_kind', (memory: Record<string, unknown>) => (memory['source'] as { kind: string }).kind],
    ['observed_status', (memory: Record<string, unknown>) => memory['observedStatus']],
  ] as const)('memories.%s decodes as unknown on a newer database', async (column, read) => {
    const { store, dbPath, memory } = await savedMemory();
    markNewer(dbPath);
    writeUnknown(dbPath, 'memories', column, 'id', memory.id);
    const stored = store.memories.get(memory.id);
    if (stored === undefined) throw new Error('memory vanished');
    expect(read(stored)).toBe('unknown');
  });

  it('memory_evidence.kind and memory_observations.status decode as unknown on a newer database', async () => {
    const { store, dbPath, memory } = await savedMemory();
    markNewer(dbPath);
    writeUnknown(dbPath, 'memory_evidence', 'kind', 'memory_id', memory.id);
    writeUnknown(dbPath, 'memory_observations', 'status', 'memory_id', memory.id);
    expect(store.memories.get(memory.id)?.evidence.map((entry) => entry.kind)).toEqual(['unknown']);
    expect(store.memories.observations(memory.id).map((entry) => entry.status)).toEqual(['unknown']);
  });

  it('a memory of an unknown scope is not recalled in any scope', async () => {
    const { store, dbPath, memory } = await savedMemory();
    markNewer(dbPath);
    writeUnknown(dbPath, 'memories', 'scope', 'id', memory.id);
    const page = store.memories.recallPage({ trusted: true, project: '/work/a' }, { terms: [], after: null, limit: 100 });
    expect(page.memories.map((entry) => entry.id)).not.toContain(memory.id);
  });
});

describe('governing fact columns this build does not know (11.4)', () => {
  it.each([
    ['scope_level', false, (fact: Record<string, unknown>) => (fact['scope'] as { level: string }).level],
    ['source_kind', false, (fact: Record<string, unknown>) => (fact['source'] as { kind: string }).kind],
    ['enforcement_behavior', true, (fact: Record<string, unknown>) => (fact['enforcement'] as { behavior: string }).behavior],
  ] as const)('governing_facts.%s decodes as unknown on a newer database', async (column, enforced, read) => {
    const { store, dbPath, fact } = governingFact(enforced);
    markNewer(dbPath);
    writeUnknown(dbPath, 'governing_facts', column, 'id', fact.id);
    const stored = store.governing.get(fact.id);
    if (stored === undefined) throw new Error('fact vanished');
    expect(read(stored)).toBe('unknown');
  });
});

describe('a mode.changed event of a mode this build does not know (11.4)', () => {
  it('decodes with the mode unknown on a newer database, and throws as corruption otherwise', async () => {
    for (const newer of [true, false]) {
      const { store, dbPath } = harness();
      const session = newSession(store);
      const db = rawDb(dbPath);
      if (newer) recordNewerMigration(db);
      appendForeignSessionEvent(db, session.id, 'mode.changed', { mode: UNKNOWN });
      db.close();
      if (newer) expect(store.readSessionEvents(session.id, 0, 100).filter((event) => event.type === 'mode.changed').map((event) => ('mode' in event ? event.mode : undefined))).toEqual(['unknown']);
      else expect(() => store.readSessionEvents(session.id, 0, 100)).toThrow(/unexpected value/);
    }
  });
});

const factsRow = (runId: string, sessionId: string): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId,
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: 0,
  endedAt: 0,
  elapsedMs: 0,
  humanWaitMs: 0,
  tokensTotal: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: false,
  met: true,
  recoveries: [{ ordinal: 1, cause: 'process_lost', failedAt: 0, progressAt: 1, outcome: 'recovered', startedSeq: 1, progressSeq: 2 }],
});

describe('run facts this build does not know (11.4)', () => {
  it.each([
    ['run_facts', 'status', 'run_id', (facts: RunFactsView) => facts.status],
    ['run_facts', 'mode', 'run_id', (facts: RunFactsView) => facts.mode],
    ['run_recoveries', 'cause', 'run_id', (facts: RunFactsView) => facts.recoveries[0]?.cause],
    ['run_recoveries', 'outcome', 'run_id', (facts: RunFactsView) => facts.recoveries[0]?.outcome],
  ] as const)('%s.%s decodes as unknown on a newer database', async (table, column, where, read) => {
    const { store, dbPath } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id);
    store.runFacts.commit({ rows: [factsRow(run.id, session.id)], calls: [], unavailable: [], throughEventId: 0 });
    markNewer(dbPath);
    writeUnknown(dbPath, table, column, where, run.id);
    const stored = store.runFacts.get(run.id);
    if (stored?.kind !== 'facts') throw new Error(`expected facts, got ${stored?.kind}`);
    expect(read(stored.facts)).toBe('unknown');
    expect(store.runFacts.page('', 10).rows.map(read)).toEqual(['unknown']);
  });
});

describe('a search document of an origin this build does not know (11.4)', () => {
  it('is returned with the origin unknown and never shown to another project', async () => {
    const { store, dbPath, dir } = harness();
    const run = await finishedRun(store, `${dir}/a`, 'remember the zebra deployment');
    await indexAll(store);
    markNewer(dbPath);
    writeUnknown(dbPath, 'search_docs', 'origin', 'run_id', run.id);
    writeUnknown(dbPath, 'runs', 'origin', 'id', run.id);
    const own = anchorsOf(store.search.query({ trusted: true, project: `${dir}/a` }, { query: 'zebra', scope: 'project' }));
    expect(own.map((anchor) => [anchor.runId, anchor.origin])).toEqual([[run.id, 'unknown']]);
    expect(anchorsOf(store.search.query({ trusted: true, project: `${dir}/b` }, { query: 'zebra', scope: 'all' }))).toEqual([]);
    const read = await store.search.readRange({ trusted: true, project: `${dir}/a` }, { runId: run.id, limit: 100, redactor });
    expect(read.kind === 'ok' ? read.origin : read.kind).toBe('unknown');
  });
});
