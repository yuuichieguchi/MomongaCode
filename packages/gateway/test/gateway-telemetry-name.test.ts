import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startFake } from './cc-support.ts';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, captureStdout, ccTarget, clientFor, homePaths, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { startGatewayProcess } from '../src/process.ts';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({ serviceNames: [] as string[] }));

vi.mock('@momonga/observability', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/observability')>();
  return {
    ...original,
    createTelemetry: (options: Parameters<typeof original.createTelemetry>[0]) => {
      control.serviceNames.push(options.serviceName);
      return original.createTelemetry(options);
    },
  };
});

beforeEach(() => {
  control.serviceNames = [];
});

describe('gateway process telemetry name (system timers)', () => {
  it('the gateway process records spans with service.name momonga-gateway', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath) } } });
    captureStdout();
    const handle = await startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    const client = clientFor(handle.socketPath);
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(200);
    await handle.close();
    const traces = new DatabaseSync(path.join(homePaths(home).root, 'state', 'traces', 'gateway.db'), { readOnly: true });
    try {
      expect((traces.prepare('SELECT COUNT(*) AS count FROM spans').get() as { count: number }).count).toBeGreaterThan(0);
    } finally {
      traces.close();
    }
    expect(control.serviceNames).toEqual(['momonga-gateway']);
  });
});
