import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_HARD_EXIT_MARGIN_MS,
  SHUTDOWN_MARGIN_MS,
  daemonStopBoundMs,
  fmServeStopBoundMs,
  gatewayAbortBudgetMs,
  gatewayAbortCloseMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  managedServerReapBoundMs,
  markerReapClockBoundMs,
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
  { closeGraceMs: 0, managedServerStopGraceMs: 0 },
  { closeGraceMs: 10_000, managedServerStopGraceMs: 3000 },
  { closeGraceMs: 1, managedServerStopGraceMs: 60_000 },
  { closeGraceMs: 300_000, managedServerStopGraceMs: 7 },
];
const SAMPLED_DRAINS = [0, 1, 30_000] as const;

describe('StopProtocol.tla composes the stop bounds the way process-contract.ts does', () => {
  it('the model composes the gateway close, the child stop, the supervisor close, the daemon stop and the abort budget from these terms', () => {
    expect(definitionOf('CG')).toBe('v');
    expect(definitionOf('GW')).toBe('CG(v) + FmBound');
    expect(definitionOf('CHILD')).toBe('GW(v) + 1');
    expect(definitionOf('SUP')).toBe('CHILD(v) + REAP + 1');
    expect(definitionOf('DAEMON')).toBe('SUP(v) + 1');
    expect(definitionOf('ABUD')).toBe('FmBound + 1');
    expect(definitionOf('REAP')).toBe('FmBound');
  });

  it('GW: the gateway close is the close grace plus the managed-server stop bound (FmBound)', () => {
    for (const values of SAMPLED_VALUES) expect(gatewayMaxCloseMs(values) - values.closeGraceMs, JSON.stringify(values)).toBe(fmServeStopBoundMs(values.managedServerStopGraceMs));
  });

  it('CHILD: the child stop budget is the gateway close plus one fixed margin', () => {
    for (const values of SAMPLED_VALUES) expect(gatewayStopBudgetMs(values) - gatewayMaxCloseMs(values), JSON.stringify(values)).toBe(SHUTDOWN_MARGIN_MS);
  });

  it('REAP: the managed-server reap term is the bound of the marker reaper the supervisor calls', () => {
    for (const values of SAMPLED_VALUES) expect(managedServerReapBoundMs(values), JSON.stringify(values)).toBe(markerReapClockBoundMs(values.managedServerStopGraceMs));
  });

  it('SUP: the supervisor close is the child stop budget plus the reap plus a part that depends on neither value', () => {
    for (const drain of SAMPLED_DRAINS) {
      const fixed = SAMPLED_VALUES.map((values) => supervisorMaxCloseMs(drain, values) - gatewayStopBudgetMs(values) - managedServerReapBoundMs(values));
      expect(new Set(fixed).size, String(drain)).toBe(1);
      expect(fixed[0], String(drain)).toBeGreaterThan(0);
    }
  });

  it('DAEMON: the daemon stop bound is the supervisor close at the default drain plus one fixed margin', () => {
    for (const values of SAMPLED_VALUES) expect(daemonStopBoundMs(values) - supervisorMaxCloseMs(30_000, values), JSON.stringify(values)).toBe(ENTRY_HARD_EXIT_MARGIN_MS);
  });

  it('ABUD: the abort budget is the managed-server stop bound plus the same margin, never more than the child stop budget', () => {
    for (const values of SAMPLED_VALUES) {
      expect(gatewayAbortCloseMs(values), JSON.stringify(values)).toBe(fmServeStopBoundMs(values.managedServerStopGraceMs));
      expect(gatewayAbortBudgetMs(values) - gatewayAbortCloseMs(values), JSON.stringify(values)).toBe(SHUTDOWN_MARGIN_MS);
      expect(gatewayAbortBudgetMs(values)).toBeLessThanOrEqual(gatewayStopBudgetMs(values));
    }
  });
});
