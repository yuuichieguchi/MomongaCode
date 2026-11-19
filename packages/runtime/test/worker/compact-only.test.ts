import { describe, expect, it } from 'vitest';
import { NOTHING_TO_COMPACT_CODE, NOTHING_TO_COMPACT_MESSAGE } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { compactInputOf, compactPinOf } from '../../src/worker/compact-pin.ts';
import { capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 200_000;
const HOUR_MS = 3_600_000;

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const conversation: RunEventPayload[] = [
  responded(1, [assistantMessage('m1', `answer one ${'x'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(2, [assistantMessage('m2', `answer two ${'y'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question three' },
  responded(3, [assistantMessage('m3', `answer three ${'z'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question four' },
  responded(4, [assistantMessage('m4', `answer four ${'w'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question five' },
];

type Env = Awaited<ReturnType<typeof makeEnv>>;

const enqueueCompact = async (env: Env, instructions?: string) =>
  createdRun(
    await env.store.createRunAndEnqueue(env.session.id, {
      input: compactInputOf(instructions),
      timeoutMs: HOUR_MS,
      limits: {},
      pins: compactPinOf(instructions),
      history: 'inherit',
    }),
  );

const conversed = async (capabilities = capabilitiesFor(WINDOW)): Promise<Env> => {
  const env = await makeEnv({ capabilities });
  const first = await env.enqueue('question one');
  await env.seed(first.id, conversation, 'release');
  env.gateway.script.push(textStep('Done.'));
  await env.runOnce(env.worker());
  expect(env.run(first.id).status).toBe('COMPLETED');
  expect(env.gateway.compacts).toEqual([]);
  return env;
};

describe('a run whose only work is to compact the context now', () => {
  it('compacts with the one compaction call, records the counts, makes no model step and ends COMPLETED', async () => {
    const env = await conversed();
    const streamsBefore = env.gateway.streams.length;
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.gateway.compacts[0]?.request.momonga).not.toHaveProperty('instructions');
    expect(env.gateway.streams).toHaveLength(streamsBefore);
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.ofType(run.id, 'context.compacting')).toHaveLength(1);
    const [compacted] = env.ofType(run.id, 'context.compacted');
    expect(compacted?.tokensBefore).toBeGreaterThan(0);
    expect(compacted?.tokensAfter).toBeGreaterThan(0);
    expect(compacted?.tokensAfter).toBeLessThan(compacted?.tokensBefore ?? 0);
    expect(env.ofType(run.id, 'user.message').map((event) => event.text)).toEqual(['/compact']);
  });

  it('gives the text after the command to the compaction request as its focus', async () => {
    const env = await conversed();
    const run = await enqueueCompact(env, 'keep the parser decisions');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts[0]?.request.momonga?.instructions).toBe('keep the parser decisions');
    expect(env.ofType(run.id, 'user.message').map((event) => event.text)).toEqual(['/compact keep the parser decisions']);
  });

  it('ends at once with the notice when there is nothing to cut', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
    expect(env.ofType(run.id, 'notice').filter((event) => event.code === NOTHING_TO_COMPACT_CODE).map((event) => event.message)).toEqual(['Nothing to compact.']);
  });

  it('gives the next run the summary in place of what was cut', async () => {
    const env = await conversed();
    const compact = await enqueueCompact(env);
    await env.runOnce(env.worker());
    expect(env.run(compact.id).status).toBe('COMPLETED');
    const next = await env.enqueue('question six');
    env.gateway.script.push(textStep('Done again.'));

    await env.runOnce(env.worker());

    expect(env.run(next.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const sent = JSON.stringify(env.gateway.streams.at(-1)?.body.input);
    expect(sent).toContain('question six');
    expect(sent).not.toContain('answer one');
    expect(sent).not.toContain('/compact');
  });

  it('does not give the next run the command when the compaction carried a focus', async () => {
    const env = await conversed();
    const compact = await enqueueCompact(env, 'keep the parser decisions');
    await env.runOnce(env.worker());
    expect(env.run(compact.id).status).toBe('COMPLETED');
    const next = await env.enqueue('question six');
    env.gateway.script.push(textStep('Done again.'));

    await env.runOnce(env.worker());

    expect(env.run(next.id).status).toBe('COMPLETED');
    const sent = JSON.stringify(env.gateway.streams.at(-1)?.body.input);
    expect(sent).not.toContain('/compact');
    expect(sent).not.toContain('keep the parser decisions');
  });
});

const seededWith = async (turns: readonly RunEventPayload[]): Promise<Env> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  const first = await env.enqueue('question one');
  await env.seed(first.id, turns, 'release');
  env.gateway.script.push(textStep('Done.'));
  await env.runOnce(env.worker());
  expect(env.run(first.id).status).toBe('COMPLETED');
  return env;
};

describe('a compact command over a short session', () => {
  it('compacts a session of one large turn', async () => {
    const env = await seededWith([responded(1, [assistantMessage('m1', `answer one ${'x'.repeat(40_000)}`)])]);
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(env.ofType(run.id, 'notice').filter((event) => event.code === NOTHING_TO_COMPACT_CODE)).toEqual([]);
    expect(env.ofType(run.id, 'notice').map((event) => event.code)).toContain('recent_turns_shrunk');
  });

  it('compacts a session of two large turns', async () => {
    const env = await seededWith([
      responded(1, [assistantMessage('m1', `answer one ${'x'.repeat(40_000)}`)]),
      { type: 'user.message', text: 'question two' },
      responded(2, [assistantMessage('m2', `answer two ${'y'.repeat(40_000)}`)]),
    ]);
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
  });

  it.each([
    ['one short turn', [responded(1, [assistantMessage('m1', 'ok')])]],
    [
      'two short turns',
      [
        responded(1, [assistantMessage('m1', 'ok')]),
        { type: 'user.message', text: 'question two' },
        responded(2, [assistantMessage('m2', 'fine')]),
      ],
    ],
  ] as const)('over %s writes the one row that there is nothing to compact, with no figure and no model call', async (_name, turns) => {
    const env = await seededWith(turns);
    const streamsBefore = env.gateway.streams.length;
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toEqual([]);
    expect(env.gateway.streams).toHaveLength(streamsBefore);
    const notices = env.ofType(run.id, 'notice').filter((event) => event.code === NOTHING_TO_COMPACT_CODE);
    expect(notices.map((notice) => notice.message)).toEqual([NOTHING_TO_COMPACT_MESSAGE]);
    expect(notices[0]?.message).not.toMatch(/-\d/);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
  });
});

describe('the levels of a manual compaction', () => {
  it('compacts a conversation whose only large turn lies inside the recent turns the first level keeps', async () => {
    const env = await seededWith([
      responded(1, [assistantMessage('m1', 'ok')]),
      { type: 'user.message', text: 'question two' },
      responded(2, [assistantMessage('m2', `answer two ${'y'.repeat(40_000)}`)]),
      { type: 'user.message', text: 'question three' },
      responded(3, [assistantMessage('m3', 'fine')]),
    ]);
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(env.ofType(run.id, 'notice').filter((event) => event.code === NOTHING_TO_COMPACT_CODE)).toEqual([]);
    expect(env.ofType(run.id, 'notice').map((event) => event.code)).toContain('recent_turns_shrunk');
  });

  it('over a small conversation builds no plan at any level and calls no model', async () => {
    const env = await seededWith([
      responded(1, [assistantMessage('m1', 'ok')]),
      { type: 'user.message', text: 'question two' },
      responded(2, [assistantMessage('m2', 'fine')]),
      { type: 'user.message', text: 'question three' },
      responded(3, [assistantMessage('m3', 'good')]),
    ]);
    const streamsBefore = env.gateway.streams.length;
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    expect(env.gateway.compacts).toEqual([]);
    expect(env.gateway.streams).toHaveLength(streamsBefore);
    expect(env.ofType(run.id, 'context.compacting')).toEqual([]);
    expect(env.ofType(run.id, 'notice').filter((event) => event.code === NOTHING_TO_COMPACT_CODE).map((event) => event.message)).toEqual([NOTHING_TO_COMPACT_MESSAGE]);
  });
});

const holdsCompaction = (input: unknown): boolean => Array.isArray(input) && input.some((item: { type?: unknown }) => item.type === 'compaction');

describe('the size after a compaction', () => {
  it('is the token count of the rebuilt input when the model counts tokens', async () => {
    const env = await conversed();
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    const [compacted] = env.ofType(run.id, 'context.compacted');
    expect(compacted).not.toHaveProperty('tokensAfterEstimated');
    const rebuiltCounts = env.gateway.counts.flatMap((request, index) => (holdsCompaction(request.input) ? [env.gateway.countResults[index]?.input_tokens] : []));
    expect(rebuiltCounts).toContain(compacted?.tokensAfter);
  });

  it('is the labelled estimate when the model does not count tokens', async () => {
    const env = await conversed(capabilitiesFor(WINDOW, { tokenCounting: 'estimated' }));
    const run = await enqueueCompact(env);

    await env.runOnce(env.worker());

    const [compacted] = env.ofType(run.id, 'context.compacted');
    expect(compacted?.tokensAfter).toBeGreaterThan(0);
    expect(compacted?.tokensAfterEstimated).toBe(true);
  });
});
