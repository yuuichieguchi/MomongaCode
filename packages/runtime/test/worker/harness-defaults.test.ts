import { describe, expect, it } from 'vitest';
import { defaultContextSettings } from '@momonga/config';
import { createFakeSettings } from './fake-settings.ts';

describe('the worker harness settings', () => {
  it('pin the context section the product resolves when nothing is configured', async () => {
    const settings = createFakeSettings({ home: '/h', project: '/p' });
    const session = { cwd: '/p' } as Parameters<typeof settings.context>[0];
    expect(await settings.context(session, AbortSignal.abort())).toEqual(defaultContextSettings());
  });
});
