import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWEEP_INTERVAL_MS } from '@momonga/foundation';
import { GATEWAY_STATE_IN_MODEL } from '@momonga/gateway';
import { readManifest } from './formal/manifest.ts';

const root = path.resolve(import.meta.dirname, '..');
const specDir = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'UpdateSwitch.tla'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const sourceOf = (...parts: string[]): string => fs.readFileSync(path.join(root, 'packages', ...parts), 'utf8');

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

describe('UpdateSwitch.tla and the gateway agree', () => {
  it('every health state of the gateway is a state of gw in the model', () => {
    const modelStates = /gw \\in \[G0 -> \{([^}]*)\}\]/.exec(spec)?.[1]?.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
    expect(modelStates).toEqual(['none', 'serving', 'retiring', 'gone']);
    for (const state of Object.values(GATEWAY_STATE_IN_MODEL)) expect(modelStates).toContain(state);
    expect(Object.keys(GATEWAY_STATE_IN_MODEL).sort()).toEqual(['draining', 'retiring', 'running']);
  });

  it('GwRetire needs the record to name a newer generation, as the role of the code does', () => {
    expect(definitionOf('GwRetire')).toContain('gw[g] = "serving" /\\ Retiring(g)');
    expect(sourceOf('foundation', 'src', 'generation-role.ts')).toContain("return currentGeneration === generation ? 'serving' : 'retiring';");
  });

  it('a new call starts only while serving, and the code refuses it while retiring before anything is sent upstream', () => {
    expect(definitionOf('GwCallStart')).toContain('gw[g] = "serving"');
    const app = sourceOf('gateway', 'src', 'server', 'app.ts');
    for (const route of ['/v1/responses', '/v1/responses/compact', '/v1/momonga/count_tokens']) {
      expect(app).toContain(`app.post('${route}', async (context) => {\n    refuseWhileRetiring();`);
    }
  });

  it('GwExit needs no open call and no open flight, and the code asks to leave only when it holds neither', () => {
    const exit = definitionOf('GwExit');
    expect(exit).toContain('gw[g] = "retiring" /\\ gwProbe[g] = 0');
    expect(exit).toContain('gwOpen[g] = 0');
    const process = sourceOf('gateway', 'src', 'process.ts');
    expect(process).toContain('const holdsNothing = (): boolean => gateway.activeRequests() === 0;');
    expect(process).toContain("if (standing === 'busy' || phase !== 'running' || role.current() !== 'retiring' || !holdsNothing()) return;");
    expect(sourceOf('gateway', 'src', 'server', 'gateway.ts')).toContain('(options.probeFlights?.() ?? 0)');
  });

  it('a flight starts only while serving and not during a user stop', () => {
    expect(definitionOf('GwFlightStart')).toContain('gw[g] = "serving" /\\ ~dr[g]');
    expect(sourceOf('gateway', 'src', 'probe', 'auto-probe.ts')).toContain("if (inFlight.has(flight) || stop.signal.aborted || options.role?.current() === 'retiring') return probing(options.retryAfterMs);");
  });

  it('the gateway and the runtime tick by the one constant of foundation', () => {
    expect(SWEEP_INTERVAL_MS).toBe(1000);
    expect(sourceOf('gateway', 'src', 'process.ts')).toMatch(/\n {2}SWEEP_INTERVAL_MS,\n\} from '@momonga\/foundation';/);
    expect(sourceOf('gateway', 'src', 'process.ts')).toContain('}, SWEEP_INTERVAL_MS);');
    expect(sourceOf('runtime', 'src', 'service', 'service.ts')).toMatch(/import \{[^}]*\bSWEEP_INTERVAL_MS\b[^}]*\} from '@momonga\/foundation';/);
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
