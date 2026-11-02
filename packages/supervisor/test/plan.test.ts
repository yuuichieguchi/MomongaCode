import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ResolvedSettings } from '@momonga/config';
import type { ChildRole } from '../src/launcher.ts';
import { digestsOf, planRoles, runRestartPlan } from '../src/plan.ts';
import type { RestartPlanPort } from '../src/plan.ts';

type PlanInput = Pick<ResolvedSettings, 'sandbox' | 'models' | 'telemetry'>;

const modelsA = { targets: { remote: { adapter: 'chat-completions', model: 'a', baseUrl: 'https://x/v1' } }, aliases: { default: 'remote' } };
const modelsB = { targets: { remote: { adapter: 'chat-completions', model: 'b', baseUrl: 'https://x/v1' } }, aliases: { default: 'remote' } };

const settings = (models: unknown, sandbox: string, telemetry?: unknown): PlanInput => ({ models, sandbox, ...(telemetry === undefined ? {} : { telemetry }) }) as unknown as PlanInput;

describe('digestsOf', () => {
  it('is sha256 over canonical JSON of each section', () => {
    expect(digestsOf(settings(modelsA, 'seatbelt'))).toEqual({
      sandbox: sha256Hex(canonicalJson('seatbelt')),
      models: sha256Hex(canonicalJson(modelsA)),
      telemetry: sha256Hex(canonicalJson(null)),
    });
  });

  it('digests telemetry settings and treats their absence as null', () => {
    const otlp = { otlp: { endpoint: 'http://127.0.0.1:4318' } };
    expect(digestsOf(settings(modelsA, 'seatbelt', otlp)).telemetry).toBe(sha256Hex(canonicalJson(otlp)));
    expect(digestsOf(settings(modelsA, 'seatbelt', otlp)).telemetry).not.toBe(digestsOf(settings(modelsA, 'seatbelt')).telemetry);
  });

  it('same digest after reformatting', () => {
    const reordered = { aliases: { default: 'remote' }, targets: { remote: { baseUrl: 'https://x/v1', model: 'a', adapter: 'chat-completions' } } };
    expect(digestsOf(settings(reordered, 'seatbelt'))).toEqual(digestsOf(settings(modelsA, 'seatbelt')));
  });
});

describe('planRoles', () => {
  const a = { sandbox: 's1', models: 'm1', telemetry: 't1' };
  const g = { models: 'm1', telemetry: 't1' };

  it('models change gives runtime then gateway', () => {
    expect(planRoles({ sandbox: 's1', models: 'm2', telemetry: 't1' }, { runtime: a, gateway: g })).toEqual(['runtime', 'gateway']);
  });

  it('sandbox change gives only the runtime', () => {
    expect(planRoles({ sandbox: 's2', models: 'm1', telemetry: 't1' }, { runtime: a, gateway: g })).toEqual(['runtime']);
  });

  it('telemetry change restarts the runtime and the gateway because both export spans', () => {
    expect(planRoles({ sandbox: 's1', models: 'm1', telemetry: 't2' }, { runtime: a, gateway: g })).toEqual(['runtime', 'gateway']);
  });

  it('no change gives no plan', () => {
    expect(planRoles({ sandbox: 's1', models: 'm1', telemetry: 't1' }, { runtime: a, gateway: g })).toEqual([]);
  });

  it('both changed is still the coordinated restart', () => {
    expect(planRoles({ sandbox: 's2', models: 'm2', telemetry: 't1' }, { runtime: a, gateway: g })).toEqual(['runtime', 'gateway']);
  });
});

type FakePortOptions = {
  draining?: () => boolean;
  startThrows?: ChildRole;
  onStop?: (role: ChildRole) => Promise<void> | void;
};

const fakePort = (options: FakePortOptions = {}) => {
  const calls: string[] = [];
  const planStopped = new Set<ChildRole>();
  const port: RestartPlanPort = {
    isDraining: () => options.draining?.() ?? false,
    stop: async (role) => {
      calls.push(`stop:${role}`);
      await options.onStop?.(role);
      planStopped.add(role);
    },
    start: (role) => {
      calls.push(`start:${role}`);
      if (!planStopped.has(role)) return;
      if (options.startThrows === role) throw new Error(`start ${role} exploded`);
      planStopped.delete(role);
    },
    awaitSettled: async (role, timeoutMs) => {
      calls.push(`settled:${role}:${timeoutMs}`);
    },
    isPlanStopped: (role) => planStopped.has(role),
  };
  return { port, calls, planStopped };
};

describe('runRestartPlan', () => {
  it('models change restarts runtime then gateway then runtime comes up', async () => {
    const { port, calls } = fakePort();
    await runRestartPlan({ roles: ['runtime', 'gateway'], port, signal: new AbortController().signal, startupTimeoutMs: 60_000 });
    expect(calls).toEqual(['stop:runtime', 'stop:gateway', 'start:gateway', 'settled:gateway:60000', 'start:runtime']);
  });

  it('sandbox change restarts only the runtime', async () => {
    const { port, calls } = fakePort();
    await runRestartPlan({ roles: ['runtime'], port, signal: new AbortController().signal, startupTimeoutMs: 60_000 });
    expect(calls.filter((call) => call.includes('gateway'))).toEqual([]);
    expect(calls).toEqual(['stop:runtime', 'start:runtime']);
  });

  it('a plan that throws still starts the stopped children', async () => {
    const { port, calls, planStopped } = fakePort({ startThrows: 'gateway' });
    await runRestartPlan({ roles: ['runtime', 'gateway'], port, signal: new AbortController().signal, startupTimeoutMs: 60_000 }).catch(() => undefined);
    expect(calls.filter((call) => call === 'start:runtime')).toHaveLength(1);
    expect(planStopped.has('runtime')).toBe(false);
  });

  it('a plan that throws while draining starts nothing', async () => {
    let draining = false;
    const { port, calls } = fakePort({
      startThrows: 'gateway',
      onStop: (role) => {
        if (role === 'gateway') draining = true;
      },
      draining: () => draining,
    });
    await runRestartPlan({ roles: ['runtime', 'gateway'], port, signal: new AbortController().signal, startupTimeoutMs: 60_000 }).catch(() => undefined);
    expect(calls.filter((call) => call.startsWith('start:'))).toEqual([]);
  });

  it('shutdown during a plan never starts a child', async () => {
    const controller = new AbortController();
    let draining = false;
    const { port, calls, planStopped } = fakePort({
      onStop: (role) => {
        if (role === 'gateway') {
          draining = true;
          controller.abort();
        }
      },
      draining: () => draining,
    });
    await runRestartPlan({ roles: ['runtime', 'gateway'], port, signal: controller.signal, startupTimeoutMs: 60_000 }).catch(() => undefined);
    expect(calls).toEqual(['stop:runtime', 'stop:gateway']);
    expect([...planStopped].sort()).toEqual(['gateway', 'runtime']);
  });

  it('an aborted plan stops at the stop it is waiting for', async () => {
    const controller = new AbortController();
    const { port, calls } = fakePort({
      onStop: (role) => {
        if (role === 'runtime') controller.abort();
      },
      draining: () => controller.signal.aborted,
    });
    await runRestartPlan({ roles: ['runtime', 'gateway'], port, signal: controller.signal, startupTimeoutMs: 60_000 }).catch(() => undefined);
    expect(calls).toEqual(['stop:runtime']);
  });

  it('a plan whose child left ready before its stop is not stalled', async () => {
    const calls: string[] = [];
    let gatewayPlanStopped = false;
    const port: RestartPlanPort = {
      isDraining: () => false,
      stop: async (role) => {
        calls.push(`stop:${role}`);
        if (role === 'gateway') gatewayPlanStopped = true;
      },
      start: (role) => {
        calls.push(`start:${role}`);
        if (role === 'gateway') gatewayPlanStopped = false;
      },
      awaitSettled: async (role) => void calls.push(`settled:${role}`),
      isPlanStopped: (role) => role === 'gateway' && gatewayPlanStopped,
    };
    await runRestartPlan({ roles: ['runtime', 'gateway'], port, signal: new AbortController().signal, startupTimeoutMs: 1000 });
    expect(calls.slice(0, 4)).toEqual(['stop:runtime', 'stop:gateway', 'start:gateway', 'settled:gateway']);
    expect(gatewayPlanStopped).toBe(false);
  });
});
