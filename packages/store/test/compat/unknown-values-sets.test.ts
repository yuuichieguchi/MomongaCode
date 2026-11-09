import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enqueue, harness, newSession, rawDb } from '../helpers.ts';
import { recordNewerMigration } from './fixtures.ts';

const writeUnknown = (dbPath: string, table: string, column: string, key: string, id: string | number): void => {
  const db = rawDb(dbPath);
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.exec('DROP TRIGGER IF EXISTS governing_facts_reject_rewrite');
  db.prepare(`UPDATE ${table} SET ${column} = 'from-a-newer-build' WHERE ${key} = ?`).run(id);
  db.close();
};

const withUnknownSets = (newer: boolean) => {
  const env = harness();
  const session = newSession(env.store);
  const run = enqueue(env.store, session.id);
  const job = env.store.jobs.start({ id: 'job-1', idemKey: 'job-key', sessionId: session.id, runId: run.id, callId: 'c1', command: 'sleep 1' }).job;
  env.store.reflection.enqueue(run.id);
  const fact = env.store.governing.add({
    kind: 'preference',
    target: 'style',
    text: 'prefer small functions',
    scope: { level: 'user' },
    validUntil: null,
    supersedes: [],
    enforcement: null,
    source: { kind: 'command' },
  }).fact;
  const trusted = fs.realpathSync.native(env.dir);
  env.store.trust.set(trusted, 'trusted');
  const charge = env.store.contextCharges.record({ purpose: 'reflection', runId: null, project: '/work/a', model: 'fm', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  env.store.idempotency.begin('idem-1', { expiresAt: Number.MAX_SAFE_INTEGER, meta: {} });
  const db = rawDb(env.dbPath);
  if (newer) recordNewerMigration(db);
  db.close();
  writeUnknown(env.dbPath, 'jobs', 'status', 'id', job.id);
  writeUnknown(env.dbPath, 'reflection_jobs', 'state', 'run_id', run.id);
  writeUnknown(env.dbPath, 'governing_facts', 'kind', 'id', fact.id);
  writeUnknown(env.dbPath, 'trust', 'decision', 'path', trusted);
  writeUnknown(env.dbPath, 'context_charges', 'purpose', 'id', charge.id);
  writeUnknown(env.dbPath, 'idempotency', 'state', 'key', 'idem-1');
  return { ...env, run, job, fact, trusted, charge };
};

describe('the other closed sets meet a value this build does not know (11.4)', () => {
  it('decode as unknown when the database is newer', () => {
    const { store, run, job, fact, trusted } = withUnknownSets(true);
    expect(store.jobs.get(job.id)?.status).toBe('unknown');
    expect(store.reflection.get(run.id)?.state).toBe('unknown');
    expect(store.governing.get(fact.id)?.kind).toBe('unknown');
    expect(store.trust.get(trusted)).toBe('unknown');
    expect(store.contextCharges.list().map((charge) => charge.purpose)).toEqual(['unknown']);
  });

  it('throw as corruption when the database is not newer', () => {
    const { store, run, job, fact, trusted } = withUnknownSets(false);
    expect(() => store.jobs.get(job.id)).toThrow(/column status has unexpected value "from-a-newer-build"/);
    expect(() => store.reflection.get(run.id)).toThrow(/column state has unexpected value "from-a-newer-build"/);
    expect(() => store.governing.get(fact.id)).toThrow(/column kind has unexpected value "from-a-newer-build"/);
    expect(() => store.trust.get(trusted)).toThrow(/column decision has unexpected value "from-a-newer-build"/);
    expect(() => store.contextCharges.list()).toThrow(/column purpose has unexpected value "from-a-newer-build"/);
    expect(() => store.idempotency.get('idem-1')).toThrow(/column state has unexpected value "from-a-newer-build"/);
  });

  it('are not acted on: an idempotency record of an unknown state is refused, not treated as unknown-outcome', () => {
    const { store } = withUnknownSets(true);
    expect(() => store.idempotency.get('idem-1')).toThrow(/does not know/);
    expect(() => store.idempotency.begin('idem-1', { expiresAt: Number.MAX_SAFE_INTEGER, meta: {} })).toThrow(/does not know/);
  });

  it('are not acted on: a trust decision this build does not know grants no trust', () => {
    const { store, trusted } = withUnknownSets(true);
    expect(store.trust.decisionFor(trusted).decision).toBe('unknown');
  });
});
