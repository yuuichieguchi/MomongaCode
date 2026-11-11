import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUserSettingsCache } from '@momonga/config';
import type { KeptRecords } from '@momonga/config';
import * as runtime from '@momonga/runtime';
import { createSession, makeRuntimeFixture, writeProjectSettings, writeUserSettings } from './helpers.ts';
import { NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';

const failingRecords = (): KeptRecords => ({
  load: async () => undefined,
  save: async () => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  },
});

describe('a failed write of the kept copy never fails the read that triggered it', () => {
  it('the user cache snapshot and read return the valid settings, and one log line names the file and the reason', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { permissions: { defaultMode: 'plan' } });
    const warnings: string[] = [];
    const cache = createUserSettingsCache({ home: f.temp.home, onWarning: (warning) => warnings.push(warning), keptRecords: failingRecords() });

    const snapshot = await cache.load(new AbortController().signal);
    expect('error' in snapshot ? snapshot.error.message : snapshot.settings.permissions.defaultMode).toBe('plan');
    expect((await cache.loadOrKeep(new AbortController().signal)).settings.permissions.defaultMode).toBe('plan');
    expect(cache.read().settings.permissions.defaultMode).toBe('plan');

    const userFile = path.join(f.temp.home, '.momonga', 'settings.json');
    const lines = warnings.filter((warning) => warning.includes('could not keep') && warning.includes(userFile));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ENOSPC');
  });

  it('a runtime read of a valid project file returns its settings, and one log line names the failure', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    await f.store.trust.setAsked(f.temp.project, 'trusted', NEVER_CANCELLED);
    writeProjectSettings(f.temp.project, { permissions: { allow: ['Bash(ls)'] } });
    const warnings: string[] = [];
    const cache = createUserSettingsCache({ home: f.temp.home, onWarning: (warning) => warnings.push(warning), keptRecords: failingRecords() });
    const composition = runtime.createSettingsComposition({ lock: testKernelLock(), signal: new AbortController().signal, home: f.temp.home, platform: process.platform, cache, store: f.store });
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });

    expect((await composition.settings.rules(session)).map((rule) => rule.text)).toEqual(['Bash(ls)']);
    expect((await composition.settings.rules(session)).map((rule) => rule.text)).toEqual(['Bash(ls)']);

    const projectFile = path.join(f.temp.project, '.momonga', 'settings.json');
    expect(warnings.filter((warning) => warning.includes('could not keep') && warning.includes(projectFile) && warning.includes('ENOSPC'))).toHaveLength(1);
  });
});
