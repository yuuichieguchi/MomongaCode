import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import type { Session } from '@momonga/store';
import { testKernelLock } from '@momonga/testkit';
import { makeCache, makeRuntimeFixture } from './helpers.ts';

type Asked = { dir: string; signal: AbortSignal };

const compositionAsking = async (asked: Asked[]): Promise<{ settings: runtime.SettingsPort; session: Session }> => {
  const f = await makeRuntimeFixture();
  const trust = f.store.trust;
  const composition = runtime.createSettingsComposition({
    lock: testKernelLock(),
    
    home: f.temp.home,
    platform: process.platform,
    cache: makeCache(f.temp.home),
    store: {
      trust: Object.assign(Object.create(trust) as typeof trust, {
        decisionAsked: (dir: string, signal: AbortSignal) => {
          asked.push({ dir, signal });
          return trust.decisionAsked(dir, signal);
        },
      }),
    },
  });
  return { settings: composition.settings, session: { cwd: f.temp.project, additionalDirectories: [] } as unknown as Session };
};

const READERS = ['rules', 'hooks', 'verification', 'memory', 'context', 'tools', 'trusted'] as const;

describe('the settings port works under the signal of the operation that asked, never the process lifetime', () => {
  it.each(READERS)('%s asks the trust decision under the signal of its asker', async (reader) => {
    const asked: Asked[] = [];
    const { settings, session } = await compositionAsking(asked);
    const request = new AbortController().signal;
    await settings[reader](session, request);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((entry) => entry.signal !== request)).toEqual([]);
  });

  it.each(READERS)('%s ends with the reason of its asker when the asker has ended', async (reader) => {
    const { settings, session } = await compositionAsking([]);
    const request = new AbortController();
    const ended = new Error('the request ended');
    request.abort(ended);
    await expect(settings[reader](session, request.signal)).rejects.toBe(ended);
  });
});
