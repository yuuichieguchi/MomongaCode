import fs from 'node:fs';
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
  identity: '0'.repeat(64),
};

const validModule = { module: 'Tiny', abstractions: ['time is a counter'], notProved: ['liveness'] };

const specDir = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla');

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
    writeFile(file, JSON.stringify({ format: MANIFEST_FORMAT, unitSuiteSeconds: 100, startupCpuSeconds: 3, modules: [validModule], entries: [{ ...validEntry, ...entry }] }));
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
    writeFile(file, JSON.stringify({ format: MANIFEST_FORMAT, unitSuiteSeconds: 100, startupCpuSeconds: 3, modules: [validModule], entries: [] }));
    expect(() => readManifest(file)).toThrow(new Error('the TLA manifest is invalid: entries must not be empty'));
  });

  const documentWith = (document: Record<string, unknown>): string => {
    const file = path.join(root, 'manifest.json');
    writeFile(file, JSON.stringify({ format: MANIFEST_FORMAT, unitSuiteSeconds: 100, startupCpuSeconds: 3, modules: [validModule], entries: [validEntry], ...document }));
    return file;
  };

  it('refuses a manifest of the format momonga-tla-manifest/1', () => {
    expect(MANIFEST_FORMAT).toBe('momonga-tla-manifest/2');
    expect(() => readManifest(documentWith({ format: 'momonga-tla-manifest/1' }))).toThrow('the TLA manifest is invalid: format must be "momonga-tla-manifest/2"');
  });

  it('reads the abstractions and the unproved claims of each module', () => {
    expect(readManifest(documentWith({})).modules).toEqual([validModule]);
  });

  it.each(['abstractions', 'notProved'])('refuses a module with no %s', (field) => {
    expect(() => readManifest(documentWith({ modules: [{ ...validModule, [field]: [] }] }))).toThrow(`the TLA manifest is invalid: modules[0].${field} must not be empty`);
    expect(() => readManifest(documentWith({ modules: [{ ...validModule, [field]: [''] }] }))).toThrow(`the TLA manifest is invalid: modules[0].${field}[0] must be a non-empty string`);
  });

  it('refuses a manifest with no modules and a module listed twice', () => {
    expect(() => readManifest(documentWith({ modules: undefined }))).toThrow('the TLA manifest is invalid: modules must be an array');
    expect(() => readManifest(documentWith({ modules: [validModule, validModule] }))).toThrow('the TLA manifest is invalid: modules[1].module Tiny is listed more than once');
  });

  it('lists every module of specs/tla once, and no module that is not on disk', () => {
    const onDisk = fs.readdirSync(specDir).filter((file) => file.endsWith('.tla')).map((file) => file.slice(0, -'.tla'.length)).sort();
    expect(readManifest(path.join(specDir, 'manifest.json')).modules.map((entry) => entry.module).sort()).toEqual(onDisk);
  });

  it('finds no comment in any TLA+ module: what a model leaves out is in the manifest', () => {
    const commented = fs.readdirSync(specDir).filter((file) => file.endsWith('.tla') && /\(\*|\\\*/.test(fs.readFileSync(path.join(specDir, file), 'utf8')));
    expect(commented).toEqual([]);
  });

  it('is reachable through the manifest module with every name of the reader, the runner and the budget', () => {
    for (const name of ['MANIFEST_FORMAT', 'readManifest', 'discoveryProblems', 'verdictProblems', 'TLC_WORKERS', 'runTlc', 'everyRunColdSeconds', 'tierBudgetProblem'] as const) {
      expect(manifestModule[name], name).toBeDefined();
    }
  });
});
