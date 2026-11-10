import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CompactRequest, RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { DEADLINE_MS, capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const RETRY_GAP_MS = 60_000;
const MAX_CLAIMS = 8;
const FIRST = 'Keep every failing test name verbatim.';
const SECOND = 'Keep every migration version verbatim.';
const CLEAN = 'GOAL:\ng\nSTATE:\ns\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';
const FABRICATED = 'GOAL:\ng\nSTATE:\n`src/ghost.ts`\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage(`m${step}`, text)], usage: USAGE },
});

const conversation = (): RunEventPayload[] => [
  responded(1, `long ${'x'.repeat(120_000)}`),
  { type: 'user.message', text: 'question two' },
  responded(2, 'answer two'),
  { type: 'user.message', text: 'question three' },
  responded(3, 'answer three'),
  { type: 'user.message', text: 'question four' },
];

const prepared = async (adopted?: string) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  if (adopted !== undefined) env.store.guidelines.adopt({ text: adopted, parent: null, report: { source: 'test' } });
  const run = env.enqueue('question one');
  await env.seed(run.id, conversation(), 'release');
  env.gateway.compactSummaries.push(CLEAN);
  env.gateway.script.push(textStep('Done.'));
  return { env, run };
};

const keyOf = (runId: string, request: CompactRequest): string => sha256Hex(canonicalJson([runId, 'compact', sha256Hex(canonicalJson(request))]));

const drive = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && env.run(runId).status !== 'COMPLETED'; claim += 1) {
    await env.runOnce(env.worker());
    env.clock.advance(RETRY_GAP_MS);
  }
};

const adoptingOutage = (env: Env, text: string, parent: number | null): void => {
  let outages = 0;
  env.gateway.compactHook = async () => {
    outages += 1;
    if (outages > 1) return;
    env.store.guidelines.adopt({ text, parent, report: { source: 'test' } });
    throw new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' });
  };
};

describe('a compaction request with an adopted guideline', () => {
  it('guards a guideline that never reaches the summariser: the text travels as momonga.guideline and changes the idempotency key', async () => {
    const { env, run } = await prepared(FIRST);
    await drive(env, run.id);
    const [compact] = env.gateway.compacts;
    expect(compact?.request.momonga?.guideline).toBe(FIRST);
    const request = compact?.request as CompactRequest;
    const { guideline: _guideline, ...momonga } = request.momonga ?? {};
    expect(compact?.idempotencyKey).toBe(keyOf(run.id, request));
    expect(compact?.idempotencyKey).not.toBe(keyOf(run.id, { ...request, momonga }));
  });

  it('guards an unattributed summary: context.compacted records the version of a model summary', async () => {
    const { env, run } = await prepared(FIRST);
    await drive(env, run.id);
    expect(env.ofType(run.id, 'context.compacted').map((event) => [event.source, event.guidelineVersion])).toEqual([['model', 1]]);
  });

  it('guards the fallback path: a rejected summary records the version that produced it', async () => {
    const { env, run } = await prepared(FIRST);
    env.gateway.compactSummaries.splice(0, 1, FABRICATED);
    await drive(env, run.id);
    expect(env.ofType(run.id, 'context.compacted').map((event) => [event.source, event.guidelineVersion])).toEqual([['deterministic', 1]]);
  });
});

describe('a run with no adopted guideline', () => {
  it('guards the default path: the request has exactly the fields of today and the key of today', async () => {
    const { env, run } = await prepared();
    await drive(env, run.id);
    const [compact] = env.gateway.compacts;
    const request = compact?.request as CompactRequest;
    const today: CompactRequest = {
      model: request.model,
      ...(request.input === undefined ? {} : { input: request.input }),
      momonga: { max_summary_tokens: request.momonga?.max_summary_tokens as number, retains_user_request: true },
    };
    expect(JSON.stringify(request)).toBe(JSON.stringify(today));
    expect(compact?.idempotencyKey).toBe(keyOf(run.id, today));
    expect(env.ofType(run.id, 'context.compacted').map((event) => event.guidelineVersion)).toEqual([0]);
  });
});

describe('the pinned guideline version', () => {
  it('guards drift by pin: run.started records the version adopted at run start', async () => {
    const { env, run } = await prepared(FIRST);
    await drive(env, run.id);
    expect(env.ofType(run.id, 'run.started').map((event) => event.pins['guidelineVersion'])).toEqual([1]);
  });

  it('guards a change mid-run: an adoption during the run, across a recovery, leaves the text, the key and the version', async () => {
    const { env, run } = await prepared(FIRST);
    adoptingOutage(env, SECOND, 1);
    await drive(env, run.id);
    expect(env.gateway.compacts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(env.gateway.compacts.map((compact) => compact.request.momonga?.guideline))).toEqual(new Set([FIRST]));
    expect(new Set(env.gateway.compacts.map((compact) => compact.idempotencyKey)).size).toBe(1);
    expect(env.ofType(run.id, 'context.compacted').map((event) => event.guidelineVersion)).toEqual([1]);
    expect(new Set(env.ofType(run.id, 'run.started').map((event) => event.pins['guidelineVersion']))).toEqual(new Set([1]));
  });

  const childOf = async (pinned: Record<string, unknown>) => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    env.store.guidelines.adopt({ text: FIRST, parent: null, report: { source: 'test' } });
    const parent = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Parent', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const claim = await env.seed(parent.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { modelAlias: 'fm', ...pinned }, mode: 'manual' }], 'hold');
    const created = env.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    expect((await env.store.releaseLease(claim, { availableAt: env.clock.now() + 3_600_000 })).kind).toBe('ok');
    env.store.guidelines.adopt({ text: SECOND, parent: 1, report: { source: 'test' } });
    env.gateway.script.push(textStep('Child done.'));
    await env.runOnce(env.worker('worker-child'));
    return env.ofType(created.run.id, 'run.started').map((event) => event.pins['guidelineVersion']);
  };

  it('guards a child that drifts from its parent: it takes the version its parent pinned, not the one adopted since', async () => {
    expect(await childOf({ guidelineVersion: 1 })).toEqual([1]);
  });

  it('guards a child that picks up a guideline its parent never had: a parent with none gives the child none', async () => {
    expect(await childOf({})).toEqual([undefined]);
  });

  it('guards a late guideline: a run that started with none stays with none across a recovery', async () => {
    const { env, run } = await prepared();
    adoptingOutage(env, FIRST, null);
    await drive(env, run.id);
    expect(env.store.guidelines.current()?.version).toBe(1);
    expect(env.gateway.compacts.every((compact) => compact.request.momonga?.guideline === undefined)).toBe(true);
    expect(env.ofType(run.id, 'context.compacted').map((event) => event.guidelineVersion)).toEqual([0]);
  });
});
