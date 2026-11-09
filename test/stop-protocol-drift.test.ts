import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_HARD_EXIT_MARGIN_MS,
  SHUTDOWN_MARGIN_MS,
  daemonStopBoundMs,
  managedServerStopBoundMs,
  gatewayAbortBudgetMs,
  gatewayAbortCloseMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  managedServerReapBoundMs,
  markerReapClockBoundMs,
  runtimeStopBudgetMs,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'StopProtocol.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const definitionOf = (name: string): string => {
  const match = spec.match(new RegExp(`^${name}(\\([^)]*\\))? ==(.*)$`, 'm'));
  if (match === null) throw new Error(`${name} is not defined in ${specPath}`);
  return (match[2] as string).trim();
};

const SAMPLED_VALUES: readonly StopValues[] = [
  { closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 0 },
  { closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: 30_000, mcpCloseGraceMs: 1000 },
  { closeGraceMs: 1, managedServerStopGraceMs: 60_000, drainTimeoutMs: 1, mcpCloseGraceMs: 30_000 },
  { closeGraceMs: 300_000, managedServerStopGraceMs: 7, drainTimeoutMs: 300_000, mcpCloseGraceMs: 1 },
];

describe('StopProtocol.tla composes the stop bounds the way process-contract.ts does', () => {
  it('the model composes the gateway close, the child stop, the supervisor close, the daemon stop and the abort budget from these terms', () => {
    expect(definitionOf('CG')).toBe('v');
    expect(definitionOf('GW')).toBe('CG(v) + FmBound');
    expect(definitionOf('CHILD')).toBe('GW(v) + KILLCONF + 1');
    expect(definitionOf('RT')).toBe('r + 1');
    expect(definitionOf('SUP')).toBe('RT(r) + CHILD(v) + KILLCONF + REAP');
    expect(definitionOf('DAEMON')).toBe('SUP(v, r) + 1');
    expect(definitionOf('ABUD')).toBe('FmBound + KILLCONF + 1');
    expect(definitionOf('REAP')).toBe('FmBound');
  });

  it('GW: the gateway close is the close grace plus the managed-server stop bound (FmBound)', () => {
    for (const values of SAMPLED_VALUES) expect(gatewayMaxCloseMs(values) - values.closeGraceMs, JSON.stringify(values)).toBe(managedServerStopBoundMs(values.managedServerStopGraceMs));
  });

  it('CHILD: the child stop budget is the gateway close plus one fixed margin', () => {
    for (const values of SAMPLED_VALUES) expect(gatewayStopBudgetMs(values) - gatewayMaxCloseMs(values), JSON.stringify(values)).toBe(SHUTDOWN_MARGIN_MS);
  });

  it('REAP: the managed-server reap term is the bound of the marker reaper the supervisor calls', () => {
    for (const values of SAMPLED_VALUES) expect(managedServerReapBoundMs(values), JSON.stringify(values)).toBe(markerReapClockBoundMs(values.managedServerStopGraceMs));
  });

  it('RT: the runtime recipient carries its own value, read at the same begin as the gateway value, and its bound enters SUP', () => {
    const spec = fs.readFileSync(specPath, 'utf8');
    expect(spec).toMatch(/rtv\[g\]\.bound = sv\[g\]/);
    expect(spec).toMatch(/sent\[g\] => rtv\[g\]\.applied = sv\[g\]/);
  });

  it('SUP: the supervisor close is the runtime stop budget, the gateway stop budget and the reap, plus a part that depends on no value', () => {
    const fixed = SAMPLED_VALUES.map((values) => supervisorMaxCloseMs(values) - runtimeStopBudgetMs(values) - gatewayStopBudgetMs(values) - managedServerReapBoundMs(values));
    expect(new Set(fixed).size).toBe(1);
    expect(fixed[0]).toBeGreaterThan(0);
  });

  it('DAEMON: the daemon stop bound is the supervisor close of the same values plus one fixed margin', () => {
    for (const values of SAMPLED_VALUES) expect(daemonStopBoundMs(values) - supervisorMaxCloseMs(values), JSON.stringify(values)).toBe(ENTRY_HARD_EXIT_MARGIN_MS);
  });

  it('ABUD: the abort budget is the managed-server stop bound plus the same margin, never more than the child stop budget', () => {
    for (const values of SAMPLED_VALUES) {
      expect(gatewayAbortCloseMs(values), JSON.stringify(values)).toBe(managedServerStopBoundMs(values.managedServerStopGraceMs));
      expect(gatewayAbortBudgetMs(values) - gatewayAbortCloseMs(values), JSON.stringify(values)).toBe(SHUTDOWN_MARGIN_MS);
      expect(gatewayAbortBudgetMs(values)).toBeLessThanOrEqual(gatewayStopBudgetMs(values));
    }
  });
});
