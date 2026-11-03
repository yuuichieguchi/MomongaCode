import { describe, expect, it } from 'vitest';
import { pinnedDigestOf } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

describe('the pinned-layer digest of a recorded request', () => {
  it('is recorded with the request, computed from the body that was sent', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('Say done');

    await env.runOnce(env.worker('worker-1'));

    const [requested] = env.ofType(run.id, 'model.requested');
    expect(requested?.pinnedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(requested?.pinnedDigest).toBe(pinnedDigestOf(requested?.body));
  });

  it('does not change with the history of the request and changes with a pinned layer or a tool', () => {
    const system = { type: 'message', role: 'system', content: 'Be careful.' };
    const body = (history: string, layers: readonly unknown[], tools: readonly unknown[]) => ({
      model: 'fm',
      input: [...layers, { type: 'message', role: 'user', content: history }],
      tools,
    });
    const base = pinnedDigestOf(body('one', [system], [{ name: 'Read' }]));
    expect(pinnedDigestOf(body('two, much longer', [system], [{ name: 'Read' }]))).toBe(base);
    expect(pinnedDigestOf(body('one', [system, { type: 'message', role: 'developer', content: 'More.' }], [{ name: 'Read' }]))).not.toBe(base);
    expect(pinnedDigestOf(body('one', [system], [{ name: 'Read' }, { name: 'Write' }]))).not.toBe(base);
  });
});
