import fs from 'node:fs';
import path from 'node:path';
import type { ManifestEntry, TlcRun } from './manifest.ts';
import { systemTempRoot } from '@momonga/testkit';

export const LIVENESS_ARGS = ['-lncheck', 'final'];

export const holdsEntry: ManifestEntry = {
  config: 'Tiny',
  role: 'check',
  expect: 'holds',
  args: [],
  tier: 'every-run',
  distinctStates: 3,
  measuredSeconds: 1,
  measuredCpuSeconds: 1,
  budgetCpuSeconds: 5,
  identity: '0'.repeat(64),
};

export const invariantEntry: ManifestEntry = {
  ...holdsEntry,
  config: 'Tiny.broken',
  role: 'evidence',
  expect: { violates: 'Small', exitCode: 12 },
};

export const temporalEntry: ManifestEntry = {
  ...holdsEntry,
  config: 'Tiny.live',
  role: 'evidence',
  expect: { violates: 'Settles', exitCode: 13 },
  args: LIVENESS_ARGS,
};

export const completedOutput = (distinct: number): string =>
  [
    'TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)',
    'Model checking completed. No error has been found.',
    `${distinct} states generated, ${distinct} distinct states found, 0 states left on queue.`,
    'Finished in 01s at (2026-11-03 10:00:00)',
  ].join('\n');

export const invariantViolationOutput = (invariant: string): string =>
  ['TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)', `Error: Invariant ${invariant} is violated.`, 'Error: The behavior up to this point is:'].join('\n');

export const actionPropertyViolationOutput = (property: string): string =>
  ['TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)', `Error: Action property ${property} is violated.`, 'Error: The behavior up to this point is:'].join('\n');

export const temporalViolationOutput = ['TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)', 'Error: Temporal properties were violated.', 'Error: The following behavior constitutes a counter-example:'].join('\n');

export const runOf = (exitCode: number, stdout: string, stderr = ''): TlcRun => ({ pid: 4242, exitCode, signal: null, killedAtCpuBudget: false, metadir: path.join(systemTempRoot(), 'mmt-fixture-tlc-4242'), stdout, stderr });

export const writeFile = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

export const tinySpec = ['---- MODULE Tiny ----', 'EXTENDS Naturals', 'VARIABLE x', 'Init == x = 0', "Next == (x < 2 /\\ x' = x + 1) \\/ (x = 2 /\\ x' = x)", 'Spec == Init /\\ [][Next]_x', 'Small == x <= 2', '===='].join('\n');

export const endlessSpec = ['---- MODULE Endless ----', 'EXTENDS Naturals', 'VARIABLE x', 'Init == x = 0', 'Next == x\' = x + 1', 'Spec == Init /\\ [][Next]_x', 'Fine == x >= 0', '===='].join('\n');

export const cfgFor = (invariant: string): string => ['SPECIFICATION Spec', '', 'INVARIANTS', `    ${invariant}`, ''].join('\n');
