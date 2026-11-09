import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETRY_KINDS } from '@momonga/foundation';
import * as gateway from '@momonga/gateway';

const specDir = path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'ManagedServer.tla'), 'utf8');
const configOf = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');
const holding = configOf('ManagedServer');
const live = configOf('ManagedServer.live');
const liveWait = configOf('ManagedServer.liveWait');
const deep = configOf('ManagedServer.deep');

const exportOf = (module: unknown, name: string, from: string): unknown => {
  const value = (module as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`${from} does not export ${name}`);
  return value;
};

const constantOf = (config: string, name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(config);
  if (match === null) throw new Error(`the configuration sets no ${name}`);
  return (match[1] as string).trim();
};

const behaviourOf = (config: string): Record<string, unknown> => ({
  reapOnStart: constantOf(config, 'ReapOnStart') === 'TRUE',
  boundedRetries: constantOf(config, 'BoundedRetries') === 'TRUE',
  cacheRefusal: constantOf(config, 'CacheRefusal') === 'TRUE',
  resetOnReady: constantOf(config, 'ResetOnReady') === 'TRUE',
  claimBounded: constantOf(config, 'ClaimBounded') === 'TRUE',
  singleFlight: constantOf(config, 'SingleFlight').replace(/"/g, ''),
  instanceWait: constantOf(config, 'InstanceWait') === 'TRUE',
});

describe('the code conforms to specs/tla/ManagedServer.tla', () => {
  it('builds the behaviour the holding configurations check: reap at start, bounded retries of a survivor, no cached refusal, no reset on ready, a bounded claim, one flight per key, a flight that waits for the running flight of its instance', () => {
    expect(behaviourOf(live)).toEqual(behaviourOf(holding));
    expect(behaviourOf(liveWait)).toEqual(behaviourOf(holding));
    expect(behaviourOf(deep)).toEqual(behaviourOf(holding));
    expect(exportOf(gateway, 'MANAGED_SERVER_BEHAVIOUR', '@momonga/gateway')).toEqual(behaviourOf(holding));
  });

  it('gives a survivor the retries of decision 12 in the safety configurations, one at each of the occasions the code names', () => {
    expect(Number(constantOf(holding, 'Retries'))).toBe(RETRY_KINDS.length);
    expect(Number(constantOf(deep, 'Retries'))).toBe(RETRY_KINDS.length);
  });

  it('keeps the supervisor reap of a gone gateway (close-grace revision 5) and the start-time reap in the model, and checks both in the every-run liveness configuration', () => {
    expect(spec).toMatch(/^SupervisorReap ==/m);
    expect(spec).toMatch(/^GoneGatewayReaped ==/m);
    expect(spec).toMatch(/^StartAfterOrphanServes ==/m);
    expect(live).toMatch(/^\s*GoneGatewayReaped\s*$/m);
    expect(live).toMatch(/^\s*StartAfterOrphanServes\s*$/m);
    expect(live).toMatch(/^\s*WaitsEnd\s*$/m);
    expect(liveWait).toMatch(/^\s*WaitsEnd\s*$/m);
    expect(liveWait).toMatch(/^\s*GwFlights\s*=\s*2\s*$/m);
  });
});
