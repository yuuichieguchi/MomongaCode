import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION, REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, expectSchema, startService } from './helpers.ts';

type FactsStore = { commit(batch: { rows: readonly RunFactsView[]; calls: readonly []; unavailable: readonly string[]; throughEventId: number }): void };

const factsOf = (store: RuntimeStore): FactsStore => (store as unknown as { runFacts: FactsStore }).runFacts;

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
  createdAt: START_MS,
  endedAt: START_MS + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
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
  recoveries: [],
});

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');

describe('GET /v1/report/facts', () => {
  it('pages the stored facts rows with a cursor, every row exactly once, each page a ReportPage', async () => {
    const env = await startService();
    const session = await env.createSession();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) ids.push((await env.createRun(session.id, { input: `run ${index}` })).id);
    factsOf(env.store).commit({ rows: ids.map((runId) => factsRow(runId, session.id)), calls: [], unavailable: [], throughEventId: 0 });

    const first = await env.http('GET', '/v1/report/facts?limit=2');
    expect(first.status).toBe(200);
    expectSchema('ReportPage', first.json);
    expect(first.json.rows).toHaveLength(2);
    expect(first.json.nextCursor).toEqual(expect.any(String));

    const second = await env.http('GET', `/v1/report/facts?limit=2&cursor=${encodeURIComponent(first.json.nextCursor as string)}`);
    expect(second.status).toBe(200);
    expectSchema('ReportPage', second.json);
    expect(second.json.nextCursor).toBeNull();
    const seen = [...first.json.rows, ...second.json.rows].map((row: RunFactsView) => row.runId);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(second.json.rows[0]).toEqual(factsRow(second.json.rows[0].runId, session.id));
  });

  it('refuses a limit above REPORT_PAGE_ROWS and serves one at the bound', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'one' });
    factsOf(env.store).commit({ rows: [factsRow(run.id, session.id)], calls: [], unavailable: [], throughEventId: 0 });
    const response = await env.http('GET', `/v1/report/facts?limit=${REPORT_PAGE_ROWS + 1}`);
    expect(response.status).toBe(400);
    const bounded = await env.http('GET', `/v1/report/facts?limit=${REPORT_PAGE_ROWS}`);
    expect(bounded.status).toBe(200);
    expect(bounded.json.rows).toHaveLength(1);
  });
});

describe('the report reads columns only (P13)', () => {
  it('store/src/run-facts.ts exists and never reads payload_json', () => {
    const source = fs.readFileSync(path.join(root, 'packages', 'store', 'src', 'run-facts.ts'), 'utf8');
    expect(source).toMatch(/run_facts/);
    expect(source).not.toMatch(/payload_json/);
  });
});
