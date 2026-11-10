import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { writeFile } from './fixtures.ts';
import * as manifestModule from './manifest.ts';
import { MANIFEST_FORMAT, readManifest } from './manifest-reader.ts';

const CONFIG_REFUSAL = 'the TLA manifest is invalid: entries[0].config must be a name made of letters, digits, ".", "_" and "-" that starts with a letter or a digit';
const ARGS_REFUSAL = 'the TLA manifest is invalid: entries[0].args must be [] or ["-lncheck","final"]';

const validEntry = {
  config: 'Tiny',
  role: 'check',
  expect: 'holds',
  args: [],
  tier: 'every-run',
  distinctStates: 3,
  measuredSeconds: 1,
  measuredCpuSeconds: 1,
  budgetCpuSeconds: 5,
};

describe('the manifest reader', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
  });

  afterEach(() => {
    removeTempRoot(root);
  });

  const manifestWith = (entry: Record<string, unknown>): string => {
    const file = path.join(root, 'manifest.json');
    writeFile(file, JSON.stringify({ format: MANIFEST_FORMAT, unitSuiteSeconds: 100, startupCpuSeconds: 3, entries: [{ ...validEntry, ...entry }] }));
    return file;
  };

  it.each(['../x', 'a/b', '.hidden'])('refuses the configuration name %s', (config) => {
    expect(() => readManifest(manifestWith({ config }))).toThrow(CONFIG_REFUSAL);
  });

  it('refuses an empty configuration name with the non-empty string text', () => {
    expect(() => readManifest(manifestWith({ config: '' }))).toThrow('the TLA manifest is invalid: entries[0].config must be a non-empty string');
  });

  it('accepts a configuration name with dots', () => {
    expect(readManifest(manifestWith({ config: 'RunRecovery.liveNone' })).entries[0]?.config).toBe('RunRecovery.liveNone');
  });

  it.each([[['-fp', '3']], [['-workers', '2']], [['-lncheck', 'seqfinal']]])('refuses the arguments %j', (args) => {
    expect(() => readManifest(manifestWith({ args }))).toThrow(ARGS_REFUSAL);
  });

  it.each([[['-lncheck', 'final']], [[]]])('accepts the arguments %j', (args) => {
    expect(readManifest(manifestWith({ args })).entries[0]?.args).toEqual(args);
  });

  it('refuses a manifest with no entries', () => {
    const file = path.join(root, 'manifest.json');
    writeFile(file, JSON.stringify({ format: MANIFEST_FORMAT, unitSuiteSeconds: 100, startupCpuSeconds: 3, entries: [] }));
    expect(() => readManifest(file)).toThrow(new Error('the TLA manifest is invalid: entries must not be empty'));
  });

  it('is still reachable through the manifest module with every name it exported before', () => {
    for (const name of ['MANIFEST_FORMAT', 'readManifest', 'discoveryProblems', 'verdictProblems', 'TLC_WORKERS', 'runTlc', 'everyRunBudgetSeconds', 'tierBudgetProblem', 'EVERY_RUN_BUDGET_RATIO'] as const) {
      expect(manifestModule[name], name).toBeDefined();
    }
    expect(manifestModule.EVERY_RUN_BUDGET_RATIO).toBe(38);
  });
});
