import { describe, expect, it, vi } from 'vitest';
import type { ClaimedToken, RunEvent, RunEventPayload } from '@momonga/protocol';
import { userShellText } from '@momonga/protocol';
import { FIDELITY_EVENT_TYPES, createFidelityFold } from '../../src/memory/fidelity-fold.ts';
import { enqueue, mustClaim, rawDb } from '../../../store/test/helpers.ts';
import { deniedCall, fidelityEnv, modelSaid, reconciledCall, startedCall, unfinishedCall } from './fidelity-fixture.ts';
import type { Claim } from './fidelity-fixture.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const TOKEN = 'make deploy-staging';

const RUN_PINS = {
  model: 'fm',
  systemPromptDigest: 'system-prompt-digest',
  toolSetDigest: 'tool-set-digest',
  capabilities: { contextWindow: 100_000, maxOutputTokens: 4096, parallelToolCalls: false, streaming: true, tokenCounting: 'exact', toolCalling: 'native' },
} as const;

type Env = Awaited<ReturnType<typeof fidelityEnv>>;

const inheriting = async (env: Env, events: readonly RunEventPayload[], input: string, outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED') => {
  const run = await enqueue(env.store, env.session.id, input);
  const claim = mustClaim(env.store, 'w1');
  expect(await env.store.inheritContext(claim, { mode: 'manual', facts: env.store.journalFacts })).toEqual({ kind: 'inherited' });
  const appended = env.store.append(claim, [{ type: 'run.started', attempt: claim.attempt, now: 0, pins: { ...RUN_PINS } }, ...events]);
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  const patch = outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {};
  const finished = await env.store.transition(claim, ['RUNNING'], outcome, patch);
  if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
  const inherited = env.allEvents(run.id).filter((event) => event.type === 'context.inherited');
  expect(inherited).toHaveLength(1);
  expect(inherited[0]).toMatchObject({ form: 'reference' });
  return run;
};

const chainOf = async (env: Env, runs: readonly (readonly RunEventPayload[])[], firstOutcome: 'COMPLETED' | 'FAILED' = 'COMPLETED') => {
  const [first, ...rest] = runs;
  const ids = [(await env.finished(first ?? [], firstOutcome, 'task of run 1')).id];
  for (const [index, events] of rest.entries()) ids.push((await inheriting(env, events, `task of run ${index + 2}`)).id);
  return ids;
};

const attestedIn = async (env: Env, runId: string, claim: Claim, token = TOKEN): Promise<string[]> => (await env.fidelity(runId, [{ token, claim }])).attested;

const summaryOf = (text: string, replacedThroughSeq: number): RunEventPayload =>
  ({ type: 'context.compacted', item: { type: 'message', role: 'user', content: text }, summary: text, replacedThroughSeq, source: 'model' }) as RunEventPayload;

describe('an inherited summary is checked against the whole record of the chain (decision 39 C, 13.12 R-F2)', () => {
  it('attests a token held only by an inherited tool output', async () => {
    const env = await fidelityEnv();
    const [, second] = await chainOf(env, [startedCall('c1', { command: 'ls' }, `log: ${TOKEN} done`), []]);
    expect(await attestedIn(env, second ?? '', 'executed')).toEqual([TOKEN]);
  });

  it('attests a token held only by an item older than the window bound of the same run', async () => {
    const env = await fidelityEnv();
    const filler = Array.from({ length: 40 }, (_unused, index) => modelSaid(index + 1, `filler answer ${index} `.padEnd(400, 'x'))).flat();
    const [, second] = await chainOf(env, [[...startedCall('c1', { command: 'ls' }, `log: ${TOKEN} done`), ...filler], []]);
    const client = await env.client();
    const window = await client.inheritedWindow({ runId: second ?? '', windowTokens: 200, floorTokens: 1 });
    expect(window['omittedOlder']).toBe(true);
    expect(JSON.stringify(window['entries'])).not.toContain(TOKEN);
    expect(await attestedIn(env, second ?? '', 'executed')).toEqual([TOKEN]);
  });

  it('attests a token held only by an item at or below the compaction floor of the reference', async () => {
    const env = await fidelityEnv();
    const [, second] = await chainOf(env, [[...startedCall('c1', { command: 'ls' }, `log: ${TOKEN} done`), summaryOf('DONE: listed the folder', 2)], []]);
    const inherited = env.allEvents(second ?? '').find((event) => event.type === 'context.inherited');
    expect(inherited).toMatchObject({ form: 'reference', compaction: expect.objectContaining({ runId: expect.any(String) }) });
    const window = await (await env.client()).inheritedWindow({ runId: second ?? '', windowTokens: 1_000_000, floorTokens: 1 });
    expect(window['omittedOlder']).toBe(false);
    expect(JSON.stringify(window['entries'])).not.toContain(TOKEN);
    expect(await attestedIn(env, second ?? '', 'executed')).toEqual([TOKEN]);
  });

  it('attests a token held three runs back in the chain', async () => {
    const env = await fidelityEnv();
    const ids = await chainOf(env, [startedCall('c1', { command: TOKEN }), [], [], []]);
    expect(await attestedIn(env, ids[3] ?? '', 'executed')).toEqual([TOKEN]);
  });

  it('attests an inherited user message for an any claim and not for an executed claim', async () => {
    const env = await fidelityEnv();
    const [, second] = await chainOf(env, [[{ type: 'user.message', text: `please run ${TOKEN} later` } as RunEventPayload], []]);
    expect(await attestedIn(env, second ?? '', 'any')).toEqual([TOKEN]);
    expect(await attestedIn(env, second ?? '', 'executed')).toEqual([]);
  });

  it('reports a reference whose source records were removed as unreadable chain:<runId>, not as a silent miss and not as an error', async () => {
    const env = await fidelityEnv();
    const [first, second] = await chainOf(env, [startedCall('c1', { command: TOKEN }), []]);
    const db = rawDb(env.dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TRIGGER IF EXISTS events_reject_delete');
    db.prepare('DELETE FROM events WHERE run_id = ?').run(first ?? '');
    const reply = await env.fidelity(second ?? '', [{ token: TOKEN, claim: 'executed' }]);
    expect(reply.attested).toEqual([]);
    expect(reply.unreadable).toContainEqual(expect.objectContaining({ handle: `chain:${first}` }));
  });
});

describe('inherited events are classified by the one function of the run own events (13.12 R-F2a, test (g), decision 37 B)', () => {
  const both = async (events: readonly RunEventPayload[], claim: Claim, firstOutcome: 'COMPLETED' | 'FAILED' = 'COMPLETED', token = TOKEN) => {
    const single = await fidelityEnv();
    const alone = await single.finished(events, firstOutcome);
    const chained = await fidelityEnv();
    const ids = await chainOf(chained, [events, [], []], firstOutcome);
    return { single: await attestedIn(single, alone.id, claim, token), inherited: await attestedIn(chained, ids[2] ?? '', claim, token) };
  };

  it('does not attest the arguments of a call denied in run 1, in run 3 and in one run alike', async () => {
    expect(await both(deniedCall('c1', { command: TOKEN }), 'executed')).toEqual({ single: [], inherited: [] });
  });

  it('attests the arguments of a call that completed in run 1', async () => {
    expect(await both(startedCall('c1', { command: TOKEN }), 'executed')).toEqual({ single: [TOKEN], inherited: [TOKEN] });
  });

  it('does not attest the arguments of a call that started in run 1 and never completed', async () => {
    expect(await both(unfinishedCall('c1', { command: TOKEN }), 'executed')).toEqual({ single: [], inherited: [] });
  });

  it('attests the output of a tool.reconciled in run 1', async () => {
    expect(await both(reconciledCall('c1', { command: 'ls' }, 'not_applied', `reconciled: ${TOKEN} not applied`), 'executed')).toEqual({ single: [TOKEN], inherited: [TOKEN] });
  });

  it('does not attest the arguments of a call reconciled not_applied in run 1', async () => {
    expect(await both(reconciledCall('c1', { command: TOKEN }, 'not_applied', 'reconciled'), 'executed')).toEqual({ single: [], inherited: [] });
  });

  it('does not attest the text of a synthesised closure', async () => {
    const closure = 'ended with an error before this tool call ran';
    expect(await both(unfinishedCall('c1', { command: 'ls' }), 'any', 'FAILED', closure)).toEqual({ single: [], inherited: [] });
  });
});

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
};

const POOL = ['npm run alpha', 'src/beta.ts', 'make gamma', 'delta-flag', 'epsilon value'];

const generatedRun = (random: (bound: number) => number, run: number): RunEventPayload[] => {
  const token = (): string => POOL[random(POOL.length)] ?? 'none';
  const events: RunEventPayload[] = [];
  const kinds = 2 + random(5);
  for (let index = 0; index < kinds; index += 1) {
    const callId = `r${run}c${index}`;
    switch (random(8)) {
      case 0:
        events.push(...startedCall(callId, { command: token() }, `out ${token()}`));
        break;
      case 1:
        events.push(...deniedCall(callId, { command: token() }));
        break;
      case 2:
        events.push(...reconciledCall(callId, { command: token() }, 'already_applied', `rec ${token()}`));
        break;
      case 3:
        events.push(...reconciledCall(callId, { command: token() }, 'not_applied', 'rec'));
        break;
      case 4:
        events.push(...reconciledCall(callId, { command: token() }, 'unknown', 'rec'));
        break;
      case 5:
        events.push({ type: 'user.message', text: `say ${token()}` } as RunEventPayload);
        break;
      case 6:
        events.push({ type: 'plan.updated', entries: [{ content: `plan ${token()}`, priority: 'high', status: 'pending' }] } as RunEventPayload);
        break;
      default:
        events.push(...unfinishedCall(callId, { command: token() }));
    }
  }
  return events;
};

const oracle = (journals: readonly (readonly RunEvent[])[], tokens: readonly ClaimedToken[], cwd: string): string[] => {
  const withPort = createFidelityFold as unknown as (tokens: readonly ClaimedToken[], cwd: string, sessionBoundary: string, record: (event: RunEvent) => void) => ReturnType<typeof createFidelityFold>;
  const fold = withPort(tokens, cwd, 'f'.repeat(32), () => {
    throw new Error('the oracle holds no reference event');
  });
  for (const event of journals.flat()) {
    if (event.type === 'context.inherited') continue;
    if ((FIDELITY_EVENT_TYPES as readonly string[]).includes(event.type)) fold.add(event);
  }
  fold.finish();
  return [...fold.attested()].sort();
};

describe('differential: an inheriting run attests what one run holding the concatenated events attests (13.12 test (d))', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', async (seed) => {
    const random = seeded(seed);
    const env = await fidelityEnv();
    const runs = [0, 1, 2].map((run) => generatedRun(random, run));
    const ids = await chainOf(env, runs);
    const tokens: ClaimedToken[] = POOL.map((token, index) => ({ token, claim: index % 2 === 0 ? 'executed' : 'any' }));
    const last = ids[2] ?? '';
    const expected = oracle(ids.map((id) => env.allEvents(id)), tokens, env.project);
    const reply = await env.fidelity(last, tokens);
    expect(reply.unreadable).toEqual([]);
    expect([...reply.attested].sort()).toEqual(expected);
  });
});

describe('an inherited user message of the copy form offers each part by its own source', () => {
  const FENCE = 'f'.repeat(32);
  const inheritedUserMessage = (parts: readonly string[]): RunEvent =>
    ({
      seq: 1,
      runId: 'run_inheriting',
      type: 'context.inherited',
      fromRunId: 'run_parent',
      fromLastSeq: 4,
      history: [{ seq: 1, item: { type: 'message', role: 'user', content: parts.map((text) => ({ type: 'input_text', text })) } }],
      nextItemSeq: 2,
      evicted: [],
      closures: [],
      markers: [],
      digest: 'digest',
    }) as unknown as RunEvent;

  const attestedOf = async (claim: Claim, parts: readonly string[]): Promise<string[]> => {
    const fold = createFidelityFold([{ token: TOKEN, claim }], '/project', FENCE, () => undefined);
    await fold.add(inheritedUserMessage(parts));
    fold.finish();
    return fold.attested();
  };

  it('attests as executed a token held by an included shell output of the earlier run', async () => {
    const shell = userShellText({ command: 'make', exitCode: 0, output: `ran ${TOKEN}` }, FENCE);
    expect(await attestedOf('executed', ['see the output', shell])).toEqual([TOKEN]);
  });

  it('keeps a token the person only typed as stated', async () => {
    expect(await attestedOf('executed', [`please run ${TOKEN}`])).toEqual([]);
    expect(await attestedOf('any', [`please run ${TOKEN}`])).toEqual([TOKEN]);
  });

  it('keeps as stated a shell-shaped text that does not carry the session boundary', async () => {
    const forged = userShellText({ command: 'make', exitCode: 0, output: `ran ${TOKEN}` }, 'e'.repeat(32));
    expect(await attestedOf('executed', [forged])).toEqual([]);
  });
});
