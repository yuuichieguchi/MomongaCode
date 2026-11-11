import { describe, expect, it } from 'vitest';
import { createRedactor } from '@momonga/foundation';
import { anchorsOf, harness, rawDb } from './helpers.ts';
import { FAKE_KEY, finishedRun, indexAll, projectDir, redactor } from './search-fixture.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

type DocRow = { level: string; session_id: string; run_id: string; step: number | null; project: string; origin: string; outcome: string; seq_from: number; seq_to: number; at: number; body: string };

const docsOf = (dbPath: string, runId: string): DocRow[] =>
  rawDb(dbPath).prepare('SELECT * FROM search_docs WHERE run_id = :runId ORDER BY level, step').all({ runId }) as unknown as DocRow[];

const indexMatches = (dbPath: string, phrase: string): number =>
  rawDb(dbPath).prepare('SELECT count(*) AS hits FROM search_index WHERE search_index MATCH :phrase').all({ phrase: `"${phrase}"` }).map((row) => Number(row['hits']))[0] ?? -1;

const longOutput = (head: string, middle: string, tail: string): string => [head, 'a'.repeat(9000), middle, 'b'.repeat(9000), tail].join('\n');

describe('search documents', () => {
  it('builds one run document with the task, final text, touched paths and outcome, by code', async () => {
    const { store, dbPath, clock, dir } = harness();
    const project = projectDir(dir, 'a');
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    const run = await finishedRun(store, project, 'rename the widget parser', [
      { text: 'intermediate musing', tool: { name: 'Read', path: '/work/a/src/widget.ts', output: 'recorded tool text' } },
      { text: 'the parser is renamed' },
    ]);
    const finishedAt = clock.now();
    await indexAll(store);
    const [runDoc] = docsOf(dbPath, run.id).filter((doc) => doc.level === 'run');
    expect(runDoc).toMatchObject({ session_id: run.sessionId, run_id: run.id, step: null, project, origin: 'trusted', outcome: 'COMPLETED', seq_from: 1, seq_to: run.lastSeq, at: finishedAt });
    expect(runDoc?.body).toContain('rename the widget parser');
    expect(runDoc?.body).toContain('the parser is renamed');
    expect(runDoc?.body).toContain('/work/a/src/widget.ts');
    expect(runDoc?.body).toContain('COMPLETED');
    expect(runDoc?.body).not.toContain('intermediate musing');
    expect(runDoc?.body).not.toContain('recorded tool text');
  });

  it('builds one step document per step with its text, tool name, subject and seq range', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', 'task', [
      { text: 'first step says hello', tool: { name: 'Grep', path: '/work/a/one.ts', output: 'first output' } },
      { text: 'second step says bye', tool: { name: 'Read', path: '/work/a/two.ts', output: 'second output' } },
    ]);
    await indexAll(store);
    const events = store.readRunEvents(run.id, 0, 100);
    const seqOf = (type: string, step: number): number => {
      const seq = events.find((event) => event.type === type && event.step === step)?.seq;
      if (seq === undefined) throw new Error(`no ${type} in step ${step}`);
      return seq;
    };
    const steps = docsOf(dbPath, run.id).filter((doc) => doc.level === 'step' && doc.body.includes('step says'));
    expect(steps.map((doc) => doc.step)).toEqual([1, 2]);
    const [first, second] = steps;
    expect(first?.body).toContain('first step says hello');
    expect(first?.body).toContain('Grep');
    expect(first?.body).toContain('/work/a/one.ts');
    expect(first?.body).toContain('first output');
    expect(first?.body).not.toContain('second output');
    expect(first?.seq_from).toBeLessThanOrEqual(seqOf('model.responded', 1));
    expect(first?.seq_to).toBeGreaterThanOrEqual(seqOf('tool.completed', 1));
    expect(first?.seq_to).toBeLessThan(seqOf('model.responded', 2));
    expect(second?.seq_from).toBeGreaterThan(seqOf('tool.completed', 1));
    expect(second?.seq_to).toBeGreaterThanOrEqual(seqOf('tool.completed', 2));
  });

  it('keeps only the head and tail of a long output, including a tail beyond the redactor cap', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: '/work/a/big.log', output: longOutput('HEADMARK', 'MIDDLEMARK', 'TAILMARK') } }]);
    await indexAll(store);
    const body = docsOf(dbPath, run.id).map((doc) => doc.body).join('\n');
    expect(body).toContain('HEADMARK');
    expect(body).toContain('TAILMARK');
    expect(body).not.toContain('MIDDLEMARK');
  });

  it('records the outcome of a failed run', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', 'task', [], 'FAILED');
    await indexAll(store);
    expect(docsOf(dbPath, run.id).find((doc) => doc.level === 'run')?.outcome).toBe('FAILED');
  });

  it('marks a run of an untrusted folder with the untrusted origin', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', 'task');
    await indexAll(store);
    expect(docsOf(dbPath, run.id).find((doc) => doc.level === 'run')?.origin).toBe('untrusted');
  });

  it('makes a secret planted in a tool output unfindable in the bodies and in the index', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', `use ${FAKE_KEY}`, [{ text: `key ${FAKE_KEY}`, tool: { name: 'Read', path: '/work/a/.env', output: `API=${FAKE_KEY}\n` } }]);
    await indexAll(store);
    const bodies = docsOf(dbPath, run.id).map((doc) => doc.body);
    expect(bodies.join('\n')).toContain('[REDACTED]');
    expect(bodies.join('\n')).not.toContain(FAKE_KEY);
    expect(indexMatches(dbPath, 'abcdefghij')).toBe(0);
    expect(indexMatches(dbPath, 'xyz012345')).toBe(0);
    expect(anchorsOf(await store.search.query({ trusted: true, project: '/work/a' }, { query: 'abcdefghij', scope: 'project' }))).toEqual([]);
  });

  it('never cuts a secret before redacting it, wherever the head and tail end', async () => {
    const { store, dbPath } = harness();
    const lines = Array.from({ length: 2000 }, (_, index) => `${'x'.repeat(index % 11)} ${FAKE_KEY}`);
    const run = await finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: '/work/a/keys', output: lines.join('\n') } }]);
    await indexAll(store);
    const body = docsOf(dbPath, run.id).map((doc) => doc.body).join('\n');
    expect(body).not.toMatch(/sk-[a-z0-9]/);
    expect(body).not.toContain('abcdef');
    expect(body).not.toContain('456789');
  });

  it('applies the credentials configured in the injected redactor', async () => {
    const { store, dbPath } = harness();
    const configured = createRedactor({ credentials: ['plain-configured-value'] });
    const run = await finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: '/work/a/f', output: 'value plain-configured-value end' } }]);
    await store.search.indexBatch({ limit: 10, redactor: configured });
    expect(docsOf(dbPath, run.id).map((doc) => doc.body).join('\n')).not.toContain('plain-configured-value');
    expect(redactor.text('plain-configured-value')).toBe('plain-configured-value');
  });
});
