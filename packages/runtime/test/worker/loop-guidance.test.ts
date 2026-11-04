import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const echo = (callId: string, value: string) => callsStep([{ callId, name: 'Echo', args: { value } }]);

const signatureOf = (value: string): string => sha256Hex(canonicalJson([['Echo', { value }]]));

type Item = { type: string; role?: string; content?: unknown };

const inputOf = (body: unknown): Item[] => (body as { input: Item[] }).input;

const textOf = (item: Item | undefined): string => {
  if (item === undefined) return '';
  return typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
};

const isGuidance = (item: Item): boolean => item.type === 'message' && item.role === 'user' && textOf(item).includes('Echo') && textOf(item).includes('kx7same');

const guidedEnv = async (options: { cachePrefix?: boolean } = {}) => {
  const env = await makeEnv();
  env.settings.contextValue = { ...env.settings.contextValue, loopGuidance: true, cachePrefix: options.cachePrefix ?? false };
  return env;
};

const repeated = (prefix: string, value: string, count: number) => Array.from({ length: count }, (_, index) => echo(`${prefix}${index + 1}`, value));

describe('loop guidance (T5, context.loopGuidance)', () => {
  it('warns at the t-th identical call, executes it, and stops at the (t+1)-th', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(...repeated('c', 'kx7same', 4), textStep('never sent'));
    const run = env.enqueue('Loop');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toHaveLength(3);
    expect(env.gateway.streams).toHaveLength(4);
    expect(env.ofType(run.id, 'tool.started').map((event) => event.callId)).toEqual(['c1', 'c2', 'c3'].map((id) => env.gateway.callId(id)));
    expect(env.ofType(run.id, 'loop.warned').map((event) => event.signature)).toEqual([signatureOf('kx7same')]);
    const warnings = env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tool_loop_warned');
    expect(warnings.map((notice) => notice.level)).toEqual(['warning']);
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tool_loop_detected')).toHaveLength(1);
  });

  it('records the warning for the same signature before the stop (T5-1)', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(...repeated('c', 'kx7same', 4), textStep('never sent'));
    const run = env.enqueue('Loop');

    await env.runOnce(env.worker());

    const warned = env.ofType(run.id, 'loop.warned');
    const stopNotices = env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tool_loop_detected');
    expect(warned).toHaveLength(1);
    expect(stopNotices).toHaveLength(1);
    expect(warned[0]!.seq).toBeLessThan(stopNotices[0]!.seq);
  });

  it('puts the guidance last in the request right after the warning, naming the call, its arguments and the count, never the tool output', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(...repeated('c', 'kx7same', 6), textStep('never sent'));
    const run = env.enqueue('Loop', { limits: { loopThreshold: 5 } });

    await env.runOnce(env.worker());

    const requests = env.ofType(run.id, 'model.requested');
    expect(requests).toHaveLength(6);
    for (const request of requests.slice(0, 5)) expect(inputOf(request.body).some(isGuidance)).toBe(false);
    const guided = inputOf(requests[5]?.body);
    const last = guided.at(-1);
    expect(last?.type).toBe('message');
    expect(last?.role).toBe('user');
    expect(guided.filter(isGuidance)).toEqual([last]);
    const text = textOf(last);
    expect(text).toContain('Echo');
    expect(text).toContain('kx7same');
    expect(text).toMatch(/\b5\b/);
    expect(text).not.toContain('echo:kx7same');
  });

  it('carries the guidance in one request only, and the next request keeps the prefix through the history (T5-2)', async () => {
    const env = await guidedEnv({ cachePrefix: true });
    env.gateway.script.push(...repeated('c', 'kx7same', 3), echo('d1', 'w2other'), textStep('Done.'));
    const run = env.enqueue('Loop then change');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const requests = env.ofType(run.id, 'model.requested');
    expect(requests).toHaveLength(5);
    const guided = inputOf(requests[3]?.body);
    const guidanceAt = guided.length - 1;
    expect(isGuidance(guided[guidanceAt]!)).toBe(true);
    const after = inputOf(requests[4]?.body);
    expect(after.some(isGuidance)).toBe(false);
    expect(after.slice(0, guidanceAt)).toEqual(guided.slice(0, guidanceAt));
    expect(requests[4]?.prefix).toEqual({ preservedItems: guidanceAt, toolsChanged: false, causes: [] });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });

  it('warns again instead of stopping when a different call starts repeating after a warning', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(...repeated('a', 'a', 3), ...repeated('b', 'b', 4), textStep('never sent'));
    const run = env.enqueue('Two loops');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.ofType(run.id, 'loop.warned').map((event) => event.signature)).toEqual([signatureOf('a'), signatureOf('b')]);
    expect(env.toolbox.executions.map((execution) => execution.input['value'])).toEqual(['a', 'a', 'a', 'b', 'b', 'b']);
  });

  it('works at loopThreshold 2: a warning at the second identical call and a stop at the third', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(...repeated('c', 'kx7same', 3), textStep('never sent'));
    const run = env.enqueue('Loop', { limits: { loopThreshold: 2 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toHaveLength(2);
    expect(env.gateway.streams).toHaveLength(3);
    expect(env.ofType(run.id, 'loop.warned').map((event) => event.signature)).toEqual([signatureOf('kx7same')]);
    expect(textOf(inputOf(env.ofType(run.id, 'model.requested')[2]?.body).at(-1))).toMatch(/\b2\b/);
  });

  it('works at loopThreshold 32: the stop needs 31 of the 32 kept groups', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(...repeated('c', 'kx7same', 33), textStep('never sent'));
    const run = env.enqueue('Loop', { limits: { loopThreshold: 32 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toHaveLength(32);
    expect(env.ofType(run.id, 'loop.warned')).toHaveLength(1);
  });

  it('lists the distinct calls of the kept groups in the guidance, without their output', async () => {
    const env = await guidedEnv();
    env.gateway.script.push(echo('b1', 'qz4before'), ...repeated('c', 'kx7same', 3), textStep('Done.'));
    const run = env.enqueue('Loop after another call');

    await env.runOnce(env.worker());

    const requests = env.ofType(run.id, 'model.requested');
    expect(requests).toHaveLength(5);
    const text = textOf(inputOf(requests[4]?.body).at(-1));
    expect(text).toContain('kx7same');
    expect(text).toContain('qz4before');
    expect(text).not.toContain('echo:qz4before');
  });

  it('keeps the old rule with guidance off: no warning, and a stop before the t-th call runs', async () => {
    const env = await makeEnv();
    env.gateway.script.push(...repeated('c', 'kx7same', 3), textStep('never sent'));
    const run = env.enqueue('Loop');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toHaveLength(2);
    expect(env.ofType(run.id, 'loop.warned')).toEqual([]);
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tool_loop_warned')).toEqual([]);
  });
});
