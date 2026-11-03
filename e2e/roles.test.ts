import { describe, expect, it } from 'vitest';
import { createUdsClient } from '@momonga/foundation';
import { ESTIMATED_CHARACTERS_PER_TOKEN } from '@momonga/protocol';
import { isCompactionRequest, journalOfRows, ofType, summaryRoute } from './support/budget.ts';
import type { JournalEvent } from './support/budget.ts';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { UPSTREAM_MODEL, UPSTREAM_TARGET, baseSettings, contextWindowOf, startStack } from './support/stack.ts';
import { chatCompletions, reportedTokensOfRequest, textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const SUMMARY_TARGET = 'summarizer';
const SUMMARY_MODEL = 'summary-model';
const SUMMARY_ALIAS = 'cheap';
const SUMMARY = 'The user sent several long requests about unrelated subjects. Next step: answer the latest request.';
const LONG_REQUESTS = 3;
const REQUEST_WINDOW_SHARE = 8;
const SCRIPTED_OUTPUT_TOKENS = 5;

type EventRow = { seq: number; type: string; payload_json: string };
type Json = Record<string, any>;

const roleSettings = (home: E2eHome): Record<string, unknown> => {
  const models = baseSettings(home, 'none')['models'] as { aliases: Record<string, unknown>; targets: Record<string, Record<string, unknown>> };
  const primary = models.targets[UPSTREAM_TARGET] as Record<string, unknown>;
  return {
    models: {
      targets: { ...models.targets, [SUMMARY_TARGET]: { ...primary, model: SUMMARY_MODEL } },
      aliases: { ...models.aliases, [SUMMARY_ALIAS]: [SUMMARY_TARGET] },
      roles: { compaction: SUMMARY_ALIAS },
    },
  };
};

const journalOf = (home: E2eHome, runId: string): JournalEvent[] =>
  journalOfRows(readDb<EventRow>(home.paths.databases.runtime, 'SELECT seq, type, payload_json FROM events WHERE run_id = ? ORDER BY seq', runId));

const runToEnd = async (runtime: RuntimeClient, runId: string): Promise<void> => {
  const stream = runtime.events(runId);
  await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
};

const getJson = async (home: E2eHome, target: string): Promise<{ status: number; json: Json; text: string }> => {
  const client = createUdsClient(home.paths.sockets.runtime);
  try {
    const response = await client.request({ method: 'GET', path: target });
    const text = await response.text();
    return { status: response.status, json: target.includes('format=text') ? {} : (JSON.parse(text) as Json), text };
  } finally {
    await client.close();
  }
};

const modelOf = (body: unknown): unknown => (body as { model?: unknown }).model;

describe('roles: a compaction role alias', () => {
  it(titleOf('roles-compaction'), { timeout: 4 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const window = contextWindowOf(home);
    const longRequestChars = ESTIMATED_CHARACTERS_PER_TOKEN * Math.ceil(window / REQUEST_WINDOW_SHARE);
    const script = [textReply('Hello.')];
    for (let index = 0; index < LONG_REQUESTS; index += 1) script.push(textReply(`Noted ${index + 1}.`));
    const stack = await startStack({ home, sandbox: 'none', settings: roleSettings(home), script, routes: [summaryRoute(SUMMARY)] });
    const runtime = createRuntimeClient(home);
    let sessionId: string;
    const runIds: string[] = [];
    try {
      const { session } = await runtime.createSession();
      sessionId = session.id;
      const first = (await runtime.createRun(session.id, 'Say hello')).run;
      await runToEnd(runtime, first.id);
      runIds.push(first.id);
      for (let index = 0; index < LONG_REQUESTS; index += 1) {
        const long = `Request ${index + 1}. ${`filler words about unrelated subjects ${index} `.repeat(longRequestChars)}`.slice(0, longRequestChars);
        const { run } = await runtime.createRun(session.id, long);
        await runToEnd(runtime, run.id);
        runIds.push(run.id);
      }
    } finally {
      await runtime.close();
    }

    const compactions = runIds.flatMap((runId) => ofType(journalOf(home, runId), 'context.compacted'));
    expect(compactions.length, `each of ${LONG_REQUESTS} requests holds 1/${REQUEST_WINDOW_SHARE} of the ${window}-token window: one fits beside the prompt of the run, and together they pass the compaction threshold`).toBeGreaterThanOrEqual(1);
    expect(compactions.every((event) => event.data['source'] === 'model')).toBe(true);

    const posts = chatCompletions(stack.fake);
    const compactionPosts = posts.filter((post) => isCompactionRequest(post.body));
    const stepPosts = posts.filter((post) => !isCompactionRequest(post.body));
    expect(compactionPosts).toHaveLength(compactions.length);
    expect(stepPosts).toHaveLength(1 + LONG_REQUESTS);
    expect(compactionPosts.map((post) => modelOf(post.body))).toEqual(compactionPosts.map(() => SUMMARY_MODEL));
    expect(stepPosts.map((post) => modelOf(post.body))).toEqual(stepPosts.map(() => UPSTREAM_MODEL));

    for (const runId of runIds) {
      const started = ofType(journalOf(home, runId), 'run.started');
      for (const event of started) expect((event.data['pins'] as Json)['roles']).toEqual({ compaction: SUMMARY_ALIAS });
    }

    const tokensOf = (selected: typeof posts): number => selected.reduce((sum, post) => sum + reportedTokensOfRequest(post.body), 0);
    const report = await getJson(home, `/v1/cost?session=${encodeURIComponent(sessionId)}`);
    expect(report.status).toBe(200);
    const roles = report.json['total']['roles'] as Json;
    expect(Object.keys(roles).sort()).toEqual(['compaction', 'run']);
    expect(roles['compaction']).toMatchObject({ calls: compactionPosts.length, inputTokens: tokensOf(compactionPosts), outputTokens: SCRIPTED_OUTPUT_TOKENS * compactionPosts.length });
    expect(roles['run']).toMatchObject({ calls: stepPosts.length, inputTokens: tokensOf(stepPosts), outputTokens: SCRIPTED_OUTPUT_TOKENS * stepPosts.length });
    expect(report.json['total']).toMatchObject({ calls: posts.length });

    const text = await getJson(home, `/v1/cost?session=${encodeURIComponent(sessionId)}&format=text`);
    expect(text.text).toContain(`role compaction: ${compactionPosts.length} call(s)`);
    expect(text.text).toContain(`role run: ${stepPosts.length} call(s)`);
  });
});
