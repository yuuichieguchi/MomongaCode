import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { ConfigError, readAutoFitRecord, writeAutoFitRecord } from '@momonga/config';
import type { AutoFitKey, AutoFitRecord } from '@momonga/config';
import { makeDir } from './helpers.ts';
import { loadModelsSection } from './load-models.ts';
import type { LoadedModels } from './load-models.ts';
import { chatConnection } from './model-fixtures.ts';
import { testKernelLock } from '@momonga/testkit';

type KeyResult = { kind: 'known'; key: AutoFitKey } | { kind: 'unknown' };

const KEY: AutoFitKey = { classifier: 'endpoint identity', codeDigest: 'c'.repeat(64), datasetDigest: 'd'.repeat(64) };

const RECORD = {
  key: KEY,
  cases: [{ id: 'case-1', meetsMinimum: true }],
  falseAllow: { successes: 0, trials: 75, high: 0.0487 },
  falseBlock: { successes: 1, trials: 75, high: 0.0718 },
  runs: 150,
  unobserved: 2,
  recordedAt: '2026-11-10T00:00:00.000Z',
  version: '0.0.0',
};

const randomHex = (bytes: number): string => 'ab'.repeat(bytes);

const write = (directory: string, record: Record<string, unknown>): Promise<string> => writeAutoFitRecord(directory, record as unknown as AutoFitRecord, randomHex, testKernelLock());

const exported = <T>(name: string): T => {
  const value = (config as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`@momonga/config does not export ${name}`);
  return value as T;
};

const CODE = { instructions: 'judge the call', verdictSchema: { type: 'object' } };

const keyOf = (models: LoadedModels, classifier: string): AutoFitKey => {
  const result = exported<(models: unknown, classifier: string, code: unknown, probeKeys: ReadonlyMap<string, unknown>) => KeyResult>('autoFitKeyOf')(models, classifier, CODE, new Map());
  if (result.kind !== 'known') throw new Error('the classifier identity is not known');
  return result.key;
};

const identityOf = (models: LoadedModels, canon: string): string => exported<(model: unknown, probeKey: undefined) => string>('classifierIdentityOf')(models.models.get(canon), undefined);

const JUDGE = 'srv-judge.example.com-443/judge';
const SPARE = 'srv-spare.example.com-443/spare';
const CONNECTIONS = [chatConnection('https://judge.example.com/v1', ['judge']), chatConnection('https://spare.example.com/v1', ['spare'])];

describe('the stored measurement of an auto-mode classifier names the model that drove the runs', () => {
  it('a record with agentModel is written and read back', async () => {
    const directory = makeDir();
    const record = { ...RECORD, agentModel: 'ollama/devstral-small-2:latest' };
    await write(directory, record);
    expect(await readAutoFitRecord(directory, KEY)).toEqual(record);
  });

  it('a file of an earlier build, with agentAlias, is no record: it reads as nothing and never throws', async () => {
    const directory = makeDir();
    const file = await write(directory, { ...RECORD, agentModel: 'ollama/devstral-small-2:latest' });
    fs.writeFileSync(file, `${JSON.stringify({ ...RECORD, agentAlias: 'fm' }, null, 2)}\n`, { mode: 0o600 });
    await expect(readAutoFitRecord(directory, KEY)).resolves.toBeUndefined();
  });

  it.each([
    ['text that is no JSON', 'not json at all'],
    ['an empty file', ''],
    ['a record cut off while it was written', '{"key": {"classifier": "x"'],
    ['a value nested deeper than the product reads', `${'['.repeat(5000)}${']'.repeat(5000)}`],
    ['control bytes', '\u0000\u0001\u0002'],
  ])('a record that is not JSON (%s) is refused with the typed error that names the file', async (_name, text) => {
    const directory = makeDir();
    const file = await write(directory, { ...RECORD, agentModel: 'ollama/devstral-small-2:latest' });
    fs.writeFileSync(file, text, { mode: 0o600 });
    const error = await readAutoFitRecord(directory, KEY).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message.startsWith(`${file}: `)).toBe(true);
  });

  it.each([
    ['without its runs', (({ runs: _runs, ...rest }) => rest)({ ...RECORD, agentModel: 'm' })],
    ['without its key', (({ key: _key, ...rest }) => rest)({ ...RECORD, agentModel: 'm' })],
    ['that is a list', []],
    ['that is null', null],
  ])('a record %s is refused with the same typed error that names the file', async (_name, value) => {
    const directory = makeDir();
    const file = await write(directory, { ...RECORD, agentModel: 'ollama/devstral-small-2:latest' });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const error = await readAutoFitRecord(directory, KEY).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`${file}: not an auto mode measurement record`);
  });

  it('a record that is a directory is refused with the typed error that names the file', async () => {
    const directory = makeDir();
    const file = await write(directory, { ...RECORD, agentModel: 'ollama/devstral-small-2:latest' });
    fs.rmSync(file);
    fs.mkdirSync(file);
    const error = await readAutoFitRecord(directory, KEY).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message.startsWith(`${file}: `)).toBe(true);
  });

  it('the key names the identities of the models that can answer a classification, in chain order, so a change of models.fallback changes it', async () => {
    const alone = (await loadModelsSection({ connections: CONNECTIONS })).models;
    const chained = (await loadModelsSection({ connections: CONNECTIONS, fallback: [SPARE] })).models;
    const judge = identityOf(alone, JUDGE);
    const spare = identityOf(alone, SPARE);
    expect(judge).not.toBe(spare);
    expect(keyOf(alone, JUDGE).classifier).toBe(judge);
    expect(keyOf(chained, JUDGE).classifier).toBe(`${judge} > ${spare}`);
    expect(keyOf(chained, SPARE).classifier).toBe(spare);
    expect(keyOf(chained, JUDGE)).toEqual({ ...keyOf(alone, JUDGE), classifier: `${judge} > ${spare}` });
  });
});
