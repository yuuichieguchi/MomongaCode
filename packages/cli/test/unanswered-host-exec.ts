import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { waitFor } from '@momonga/testkit';

export const LIMIT_TIMERS = ['setTimeout', 'clearTimeout'] as const;

export const MANAGED_CLASSIFIER = 'apple/system';

export const outcomeOf = (promise: Promise<unknown>): Promise<{ value: unknown } | { error: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

export const homeWithAManagedModel = (): { home: string; binary: string; models: unknown } => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-key-bound-')));
  const binary = path.join(home, 'fm');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const models = { connections: [{ adapter: 'managed', server: 'fm', binary, models: [{ id: 'system', toolCalling: 'native' }] }] };
  fs.mkdirSync(path.join(home, '.momonga'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ models }), { mode: 0o600 });
  return { home, binary, models };
};

export const untilTheExecIsAsked = async (calls: readonly string[], count: number): Promise<void> => {
  await waitFor(() => calls.length >= count, { description: `the host exec to be asked ${count} times` });
};

export const isSettled = async (outcome: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void outcome.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return settled;
};
