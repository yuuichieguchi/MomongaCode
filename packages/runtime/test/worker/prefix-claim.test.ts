import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { BuiltContext } from '@momonga/context';
import type { FunctionTool, InputItem } from '@momonga/protocol';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { recordPrefix } from '../../src/worker/prefix-record.ts';
import { makeEnv } from './harness.ts';

const message = (role: 'system' | 'user' | 'assistant', text: string): InputItem => ({ type: 'message', role, content: text }) as InputItem;

const SYSTEM = message('system', 'You are the prefix test agent.');
const TASK = message('user', 'Do the work.');
const h = (text: string): InputItem => message('assistant', text);

const TOOLS: FunctionTool[] = [{ type: 'function', name: 'Echo', description: 'Echo a value', parameters: { type: 'object', properties: {} } } as FunctionTool];

const keyOf = (tools: readonly FunctionTool[], stable: readonly InputItem[]): string => sha256Hex(canonicalJson({ tools, S: stable }));

type Recorded = { input: InputItem[]; tools: FunctionTool[]; marks: { stable: number; fixed: number; history: number } };

const bodyOf = (recorded: Recorded) => ({
  model: 'fm',
  input: recorded.input,
  tools: recorded.tools,
  prompt_cache_key: keyOf(recorded.tools, recorded.input.slice(0, recorded.marks.stable)),
  momonga: { cache: recorded.marks },
});

const builtOf = (input: InputItem[], tools: FunctionTool[]): BuiltContext =>
  ({
    input,
    tools,
    maxOutputTokens: 1_000,
    zones: { stableEnd: 1, arrivalsStart: 1, arrivalsEnd: 1, fixedEnd: 2, historyEnd: input.length, arrivalKeys: [] },
  }) as unknown as BuiltContext;

const reclaimedAfter = async (recorded: Recorded) => {
  const env = await makeEnv();
  const run = await env.enqueue('Do the work.');
  await env.seed(
    run.id,
    [
      { type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' },
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: bodyOf(recorded) },
      { type: 'run.started', attempt: 2, now: env.clock.now(), pins: {}, mode: 'manual' },
    ],
    'hold',
  );
  const ctx = {
    options: { store: env.store },
    run: { id: run.id },
    journal: { state: env.fold(run.id) },
    token: { cachePrefix: true },
  } as unknown as ClaimContext;
  return ctx;
};

const PREVIOUS: Recorded = { input: [SYSTEM, TASK, h('one'), h('two'), h('three')], tools: TOOLS, marks: { stable: 1, fixed: 2, history: 5 } };

const unexplained = (record: ReturnType<typeof recordPrefix>) =>
  (record?.notices ?? []).flatMap((notice) => (notice.type === 'notice' && notice.code === 'prefix_unexplained' ? [notice] : []));

describe('a claim is classified by the sha256(tools, S) key of the previous request (review M1, section 1)', () => {
  it('expects a claim with no external change to preserve through the last history item, and names the shortfall', async () => {
    const ctx = await reclaimedAfter(PREVIOUS);

    const record = recordPrefix(ctx, builtOf([SYSTEM, TASK, h('one'), h('two, rendered differently'), h('three'), h('four')], TOOLS), false);

    expect(record?.prefix).toEqual({ preservedItems: 3, toolsChanged: false, causes: ['claim'] });
    expect(unexplained(record)).toEqual([expect.objectContaining({ type: 'notice', level: 'info', code: 'prefix_unexplained' })]);
    expect(unexplained(record)[0]?.message).toContain('fewer than the 5');
    expect(unexplained(record)[0]?.message).toContain('prompt cache');
    expect(unexplained(record)[0]?.message).not.toContain('(none)');
  });

  it('reads the previous history end from its recorded mark, in a fresh claim context', async () => {
    const ctx = await reclaimedAfter({ ...PREVIOUS, input: [SYSTEM, TASK, h('one'), h('two'), message('user', 'trailing guidance')], marks: { stable: 1, fixed: 2, history: 4 } });

    const record = recordPrefix(ctx, builtOf([SYSTEM, TASK, h('one'), h('two'), h('three')], TOOLS), false);

    expect(record?.prefix).toEqual({ preservedItems: 4, toolsChanged: false, causes: ['claim'] });
    expect(unexplained(record)).toEqual([]);
  });

  it('raises nothing when the re-derivation of an unchanged claim is deterministic', async () => {
    const ctx = await reclaimedAfter(PREVIOUS);

    const record = recordPrefix(ctx, builtOf([...PREVIOUS.input, h('four')], TOOLS), false);

    expect(record?.prefix).toEqual({ preservedItems: 5, toolsChanged: false, causes: ['claim'] });
    expect(unexplained(record)).toEqual([]);
  });

  it('expects nothing preserved after a claim with a changed S', async () => {
    const ctx = await reclaimedAfter(PREVIOUS);

    const record = recordPrefix(ctx, builtOf([message('system', 'You are a changed agent.'), TASK, h('one'), h('two'), h('three')], TOOLS), false);

    expect(record?.prefix).toEqual({ preservedItems: 0, toolsChanged: false, causes: ['claim'] });
    expect(unexplained(record)).toEqual([]);
  });

  it('expects nothing preserved after a claim with a changed offer', async () => {
    const ctx = await reclaimedAfter(PREVIOUS);
    const changed: FunctionTool[] = [...TOOLS, { type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } } as FunctionTool];

    const record = recordPrefix(ctx, builtOf([SYSTEM, TASK, h('one'), h('two, rendered differently')], changed), false);

    expect(record?.prefix).toMatchObject({ toolsChanged: true, causes: ['claim'] });
    expect(unexplained(record)).toEqual([]);
  });
});
