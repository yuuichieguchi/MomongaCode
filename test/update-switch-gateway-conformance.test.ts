import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedactor, roleOfGeneration, fixedRolePort, SWEEP_INTERVAL_MS } from '@momonga/foundation';
import { GATEWAY_STATE_IN_MODEL, createAutoProbe } from '@momonga/gateway';
import type { ProbeSubject } from '@momonga/gateway';
import { createFakeClock, createTempDir, hostTimers, removeTempDir, testKernelLock } from '@momonga/testkit';
import { readManifest } from './formal/manifest.ts';

const root = path.resolve(import.meta.dirname, '..');
const specDir = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'UpdateSwitch.tla'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in UpdateSwitch.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const entryOf = (config: string) => {
  const entry = manifest.entries.find((candidate) => candidate.config === config);
  if (entry === undefined) throw new Error(`${config} is not in the manifest`);
  return entry;
};

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) await removeTempDir(dir);
});

describe('UpdateSwitch.tla and the gateway agree', () => {
  it('every health state of the gateway is a state of gw in the model', () => {
    const modelStates = /gw \\in \[G0 -> \{([^}]*)\}\]/.exec(spec)?.[1]?.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
    expect(modelStates).toEqual(['none', 'serving', 'retiring', 'gone']);
    for (const state of Object.values(GATEWAY_STATE_IN_MODEL)) expect(modelStates).toContain(state);
    expect(Object.keys(GATEWAY_STATE_IN_MODEL).sort()).toEqual(['draining', 'retiring', 'running']);
  });

  it('GwRetire needs the record to name a newer generation: a generation below the current one is retiring, the current one serving', () => {
    expect(definitionOf('GwRetire')).toContain('gw[g] = "serving" /\\ Retiring(g)');
    expect(roleOfGeneration(2, 3)).toBe('retiring');
    expect(roleOfGeneration(3, 3)).toBe('serving');
    expect(roleOfGeneration(4, 3)).toBe('starting');
  });

  it('a new call starts only while serving; a retiring gateway refuses it before anything is sent upstream (tested by generations/retiring-refuses.test.ts)', () => {
    expect(definitionOf('GwCallStart')).toContain('gw[g] = "serving"');
  });

  it('GwExit needs no open call and no open flight (tested by generations/retiring-exit.test.ts)', () => {
    const exit = definitionOf('GwExit');
    expect(exit).toContain('gw[g] = "retiring" /\\ gwProbe[g] = 0');
    expect(exit).toContain('gwOpen[g] = 0');
  });

  it('a flight starts only while serving: a retiring gateway asks no measurement of its subject', async () => {
    expect(definitionOf('GwFlightStart')).toContain('gw[g] = "serving" /\\ ~dr[g]');

    const dir = createTempDir();
    createdDirs.push(dir);
    let measurements = 0;
    const autoProbe = createAutoProbe({
      redactor: createRedactor({ credentials: [] }),
      lock: testKernelLock(),
      dir,
      clock: createFakeClock(0),
      timers: hostTimers,
      retryAfterMs: 120_000,
      onEvent: () => undefined,
      role: fixedRolePort('retiring'),
    });
    const key = { target: 'switch', lamp: 'retiring-gateway' };
    const subject: ProbeSubject<typeof key, { ok: true }> = {
      target: 'switch',
      unknown: { fields: ['toolCalling'], declaration: 'declare toolCalling' },
      readKey: async () => key,
      precondition: { boundMs: 50, check: async () => ({ kind: 'met' }) },
      measure: () => {
        measurements += 1;
        return new Promise<{ ok: true }>(() => undefined);
      },
      save: async () => undefined,
    };

    await autoProbe.ensure(subject, key);
    await autoProbe.close();

    expect(measurements).toBe(0);
    expect(autoProbe.openFlights()).toBe(0);
  });

  it('the sweep interval is the one constant of foundation', () => {
    expect(SWEEP_INTERVAL_MS).toBe(1000);
  });

  it('the gateway configurations hold and each evidence configuration violates its property', () => {
    for (const config of ['UpdateSwitch.gateway', 'UpdateSwitch.gatewayJobs', 'ManagedServer.gens']) expect(entryOf(config).role, config).toBe('check');
    for (const config of [
      'UpdateSwitch.gwAcceptsWhileRetiring',
      'UpdateSwitch.gwExitEarly',
      'UpdateSwitch.gwGraceAbort',
      'UpdateSwitch.gwSilentRefuse',
      'UpdateSwitch.gwRefuseNoYield',
      'UpdateSwitch.userStopNeverEnds',
      'ManagedServer.sharedAcrossGenerations',
      'ManagedServer.reapOtherGeneration',
      'ManagedServer.retiringRestarts',
    ]) {
      expect(entryOf(config).role, config).toBe('evidence');
    }
  });
});
