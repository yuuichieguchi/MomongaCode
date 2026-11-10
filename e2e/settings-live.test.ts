import fs from 'node:fs';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { firstGeneration } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { supervisorLog } from './support/log-reader.ts';
import type { LogRecord } from './support/log-reader.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { startStack, upstreamModelRef, withUpstreamEntry, writeSettingsFile } from './support/stack.ts';
import { pidOf } from './support/supervisor-client.ts';
import { E2E_RECOVERY_BOUND_MS, E2E_SETTINGS_SEEN_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const CHANGED_MODEL = 'system-changed';

type Settings = Record<string, unknown>;

const withChangedModel = (home: E2eHome): Settings => {
  const changed = withUpstreamEntry(JSON.parse(fs.readFileSync(home.paths.settingsFile, 'utf8')) as Settings, (entry) => ({ ...entry, id: CHANGED_MODEL }));
  return { ...changed, models: { ...(changed['models'] as Settings), start: upstreamModelRef(CHANGED_MODEL) } };
};

const named = (records: readonly LogRecord[], msg: string): LogRecord[] => records.filter((record) => record.msg === msg);

const completed = (runtime: RuntimeClient, runId: string): Promise<string> =>
  until(
    async () => {
      const { run } = await runtime.getRun(runId);
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status) ? run.status : undefined;
    },
    { deadlineMs: E2E_RECOVERY_BOUND_MS, description: `run ${runId} to end` },
  );

describe('decision 76: a settings edit during a held run applies in place (design-settings-live section 10)', () => {
  it('the held run completes, the next run uses the new settings, and the supervisor stops and spawns no child for the change', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const runtime = createRuntimeClient(home);
    const before = await stack.client.health();
    const hold = stack.fake.hold();
    try {
      const { session } = await runtime.createSession();
      const { run: held } = await runtime.createRun(session.id, 'Say hello');
      await hold.waitForRequest();
      writeSettingsFile(home, withChangedModel(home));
      await until(() => named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length > 0, {
        deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
        description: 'the supervisor to log the settings change',
      });
      hold.release();
      expect(await completed(runtime, held.id)).toBe('COMPLETED');
      const { session: later } = await runtime.createSession();
      const { run: next } = await runtime.createRun(later.id, 'Say hello again');
      expect(await completed(runtime, next.id)).toBe('COMPLETED');
      const models = stack.fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => (request.body as { model?: string }).model);
      expect(models.at(-1)).toBe(CHANGED_MODEL);
      const records = supervisorLog(home.paths, stack.ready.pid);
      expect(named(records, 'child.stop')).toEqual([]);
      expect(named(records, 'child.spawn').map((record) => record.reason)).toEqual(['initial', 'initial']);
      const after = await stack.client.health();
      for (const role of ['runtime', 'gateway'] as const) expect(pidOf(after, role)).toBe(pidOf(before, role));
    } finally {
      hold.release();
      await runtime.close();
    }
  });

  it('with the supervisor: a valid change it has seen, then a broken file, is served by the gateway even though no request read it (15.1)', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    writeSettingsFile(home, withChangedModel(home));
    await until(() => named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length > 0, {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the supervisor to log the settings change',
    });
    writeSettingsFile(home, '{ "models": ');
    const client = createUdsClient(fixedSocket(firstGeneration(home.paths).sockets.gateway));
    try {
      const response = await client.request({
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: CHANGED_MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      const models = stack.fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => (request.body as { model?: string }).model);
      expect(models.at(-1)).toBe(CHANGED_MODEL);
    } finally {
      await client.close();
    }
  });
});
