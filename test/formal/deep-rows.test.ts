import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { completedOutput, writeFile } from './fixtures.ts';
import type { ManifestEntry } from './manifest.ts';
import { describeTier } from './tier.ts';
import { hostTlcRowsAtOnce } from './tlc-rows.ts';

const root = createTempRoot();
const modules = [{ module: 'Tiny', abstractions: ['time'], notProved: ['liveness of Tiny'] }];

const rowsOf = (tier: 'deep' | 'every-run', count: number): ManifestEntry[] =>
  Array.from({ length: count }, (_unused, index) => ({
    config: `Tiny.${tier === 'deep' ? 'deep' : 'every'}${index}`,
    role: 'check',
    expect: 'holds',
    args: [],
    tier,
    distinctStates: 3,
    measuredSeconds: 1,
    measuredCpuSeconds: 1,
    budgetCpuSeconds: 5,
  }));

const sleepingScript = (name: string, log: string): string => {
  const script = path.join(root, `${name}.sh`);
  writeFile(path.join(root, `${name}-output`), `${completedOutput(3)}\n`);
  writeFile(script, ['#!/bin/sh', `echo "start $1" >> "${log}"`, 'sleep 1', `echo "end $1" >> "${log}"`, `cat "${path.join(root, `${name}-output`)}"`, 'exit 0', ''].join('\n'));
  fs.chmodSync(script, 0o755);
  return script;
};

const deepLog = path.join(root, 'deep.log');
const everyRunLog = path.join(root, 'every-run.log');
const deepRows = rowsOf('deep', 3);
const everyRunRows = rowsOf('every-run', 3);

afterAll(() => removeTempRoot(root));

describeTier({
  tier: 'deep',
  entries: deepRows,
  modules,
  manifestConfigs: deepRows.map((entry) => entry.config),
  script: sleepingScript('deep', deepLog),
  repoRoot: root,
  env: {},
});

describeTier({
  tier: 'every-run',
  entries: everyRunRows,
  modules,
  manifestConfigs: everyRunRows.map((entry) => entry.config),
  script: sleepingScript('every-run', everyRunLog),
  repoRoot: root,
  env: {},
});

const mostAtOnce = (log: string): number => {
  let running = 0;
  let most = 0;
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
  for (const line of lines) {
    if (line.startsWith('start ')) running += 1;
    if (line.startsWith('end ')) running -= 1;
    most = Math.max(most, running);
  }
  return most;
};

describe('the rows of a tier run at once', () => {
  it('runs the deep rows as many at once as the formula of the host allows', () => {
    expect(fs.readFileSync(deepLog, 'utf8').split('\n').filter((line) => line.startsWith('end ')).length).toBe(deepRows.length);
    expect(mostAtOnce(deepLog)).toBe(Math.min(deepRows.length, hostTlcRowsAtOnce()));
  });

  it('runs the every-run rows one at a time', () => {
    expect(mostAtOnce(everyRunLog)).toBe(1);
  });
});
