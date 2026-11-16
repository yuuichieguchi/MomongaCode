import { describe, expect, it, vi } from 'vitest';
import { runProbe } from '@momonga/gateway';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeChatCompletions } from '@momonga/testkit';
import { NO_REPORTED_WINDOW } from '../src/plan/catalog.ts';
import { reportedContextCeiling, reportedContextWindow } from '../src/probe/run-probe.ts';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { ACCOUNT, accountRoute, signIn, startPlanGateway } from './plan-signin-support.ts';
import { hostProbePorts } from './probe-ports-support.ts';
import { LMSTUDIO_API_V1_MODELS, LMSTUDIO_V1_MODELS } from './detect-kinds-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CEILING = 32768;

describe('a reported maximum is a ceiling, never the window in force (design-model-names 4.14)', () => {
  it('reads a lone max_context_length as the ceiling and no window', () => {
    expect(reportedContextWindow({ max_context_length: 32768 })).toBeUndefined();
    expect(reportedContextCeiling({ max_context_length: 32768 })).toBe(32768);
  });

  it('reads neither from the measured LM Studio /v1/models answer', () => {
    expect(reportedContextWindow(LMSTUDIO_V1_MODELS)).toBeUndefined();
    expect(reportedContextCeiling(LMSTUDIO_V1_MODELS)).toBeUndefined();
  });

  it('reads the window in force 4096 and the ceiling 32768 from the measured LM Studio /api/v1/models answer', () => {
    expect(reportedContextWindow(LMSTUDIO_API_V1_MODELS)).toBe(4096);
    expect(reportedContextCeiling(LMSTUDIO_API_V1_MODELS)).toBe(32768);
  });

  it('the probe searches the window when the listing reports only a maximum', async () => {
    const window = 3000;
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', contextWindow: window, models: [{ id: 'system', object: 'model', max_context_length: CEILING }] });
    try {
      const report = await runProbe({ ports: hostProbePorts, socketPath: fake.socketPath, managed: FM_PROBE_ROUTES, samples: 2 });
      expect(report.contextWindow.method).toBe('searched');
      expect(report.contextWindow.value).toBeLessThan(CEILING);
    } finally {
      await fake.close();
    }
  });

  it('the plan catalog marks an entry with only a maximum unusable', async () => {
    const gateway = await startPlanGateway({ models: [{ slug: 'ceiling-model', display_name: 'Ceiling Model', visibility: 'list', max_context_length: CEILING }] });
    try {
      await signIn(gateway);
      const listed = await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, ACCOUNT)}?profile=chatgpt`);
      expect(listed.body.models).toEqual([{ slug: 'ceiling-model', displayName: 'Ceiling Model', usable: false, reason: NO_REPORTED_WINDOW }]);
    } finally {
      await gateway.close();
    }
  });
});
