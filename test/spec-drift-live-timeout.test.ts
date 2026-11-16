import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifest } from './formal/manifest.ts';

const root = path.resolve(import.meta.dirname, '..');
const specDir = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'RunRecovery.tla'), 'utf8');
const executorSource = fs.readFileSync(path.join(root, 'packages', 'tools', 'src', 'executor.ts'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in RunRecovery.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const configText = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');

describe('the live timeout of RunRecovery.tla against the executor', () => {
  it('models the live timeout with the reconcile outcome set: exec is unknown, a reconciling tool is already_applied, not_applied or unknown', () => {
    const outcomes = definitionOf('LiveTimeoutOutcomes');
    expect(outcomes).toMatch(/kind = "exec" THEN \{"unknown"\}/);
    expect(outcomes).toMatch(/\{"already_applied", "unknown"\}/);
    expect(outcomes).toMatch(/\{"not_applied", "unknown"\}/);
    expect(definitionOf('LiveTimeout')).toMatch(/LiveKill\(w, LiveTimeoutOutcomes\)/);
  });

  it('states KilledExecIsUnknown over the exec calls the product stopped', () => {
    expect(definitionOf('KilledExecIsUnknown')).toMatch(/flags\.killed/);
    expect(definitionOf('KilledExecIsUnknown')).toMatch(/idemRes\[k\] = "unknown"/);
  });

  it('checks the live timeout in a check configuration and shows the old behaviour violating KilledExecIsUnknown', () => {
    expect(configText('RunRecovery.liveTimeout')).toMatch(/^SPECIFICATION SpecLiveTimeout$/m);
    expect(configText('RunRecovery.liveTimeout')).toMatch(/^\s+KilledExecIsUnknown$/m);
    expect(configText('RunRecovery.liveTimeoutFailed')).toMatch(/^SPECIFICATION SpecLiveTimeoutFailed$/m);
    const check = manifest.entries.find((entry) => entry.config === 'RunRecovery.liveTimeout');
    const evidence = manifest.entries.find((entry) => entry.config === 'RunRecovery.liveTimeoutFailed');
    expect(check).toMatchObject({ role: 'check', expect: 'holds' });
    expect(evidence).toMatchObject({ role: 'evidence', expect: { violates: 'KilledExecIsUnknown', exitCode: 12 } });
  });

  it('the executor defines the one settle function, and the model live kill is defined on the call', () => {
    expect(executorSource).toMatch(/const settleInterrupted = /);
    expect(spec).toMatch(/^LiveKill\(w, outcomes\(_, _\)\) ==/m);
  });

  it('settles the live abort exit through settleInterrupted and no longer completes it as a bare failure', () => {
    expect(executorSource).not.toMatch(/scope\.complete\(\{ status: 'failed', output \}, reconciled\)/);
    expect(executorSource).toMatch(/settleInterrupted\(/);
  });
});
