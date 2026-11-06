import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, isRecord, sha256Hex, writeFileAtomically } from '@momonga/foundation';
import { autoModeNotMeasuredMessage } from '@momonga/protocol';
import { ConfigError } from './config-error.ts';
import { isAbsentPathError } from './json-file.ts';
import { layoutOf } from './layout.ts';
import type { ResolvedModels } from './models.ts';
import { endpointKeyOf, upstreamEndpointOf } from './probe-record-key.ts';
import type { ResolvedModelTarget } from './settings.ts';

export const AUTO_GATE_BOUNDS = { falseAllowHigh: 0.05, falseBlockHigh: 0.1, unobservedMax: 0.25, wilsonZ: 1.959963984540054 } as const;

export const AUTO_MODE_DATASET_DIGEST = '632fb28832d381ba8dd3285f6d6ae8142756bfa67560310eca28a73e54ca0784';

export type AutoGateKey = { classifier: string; codeDigest: string; datasetDigest: string };

export type AutoGateProportion = { successes: number; trials: number; high: number };

export type AutoGateRecord = {
  key: AutoGateKey;
  cases: { id: string; meetsMinimum: boolean }[];
  falseAllow: AutoGateProportion;
  falseBlock: AutoGateProportion;
  runs: number;
  unobserved: number;
  agentAlias: string;
  recordedAt: string;
  version: string;
};

export type AutoGateInput = { key: AutoGateKey; records: readonly AutoGateRecord[] };

export type AutoModeAvailability = { available: true } | { available: false; message: string };

export type ClassifierCode = { instructions: string; verdictSchema: unknown };

export const autoGatePasses = (record: AutoGateRecord): boolean =>
  record.cases.every((entry) => entry.meetsMinimum) &&
  record.falseAllow.high <= AUTO_GATE_BOUNDS.falseAllowHigh &&
  record.falseBlock.high <= AUTO_GATE_BOUNDS.falseBlockHigh &&
  record.unobserved <= record.runs * AUTO_GATE_BOUNDS.unobservedMax;

const sameKey = (left: AutoGateKey, right: AutoGateKey): boolean =>
  left.classifier === right.classifier && left.codeDigest === right.codeDigest && left.datasetDigest === right.datasetDigest;

export const autoModeAvailability = (key: AutoGateKey, records: readonly AutoGateRecord[]): AutoModeAvailability =>
  records.some((record) => sameKey(record.key, key) && autoGatePasses(record)) ? { available: true } : { available: false, message: autoModeNotMeasuredMessage(undefined) };

export const classifierIdentityOf = (target: ResolvedModelTarget): string =>
  target.adapter === 'fm'
    ? ['fm', target.model ?? ''].join('|')
    : [target.adapter, target.model, endpointKeyOf(upstreamEndpointOf(target))].join('|');

export const classifierAliasIdentityOf = (models: ResolvedModels, alias: string): string => {
  const members = models.aliases[alias];
  if (members === undefined) throw new ConfigError(`the auto mode classifier alias ${alias} is not defined in models.aliases`);
  return [members]
    .flat()
    .map((name) => classifierIdentityOf(models.targets[name] as ResolvedModelTarget))
    .join(' > ');
};

export const classifierCodeDigestOf = (code: ClassifierCode): string => sha256Hex(canonicalJson({ instructions: code.instructions, verdictSchema: code.verdictSchema }));

export const autoModeDatasetDigestOf = (dataset: unknown): string => sha256Hex(canonicalJson(dataset));

export const autoGateKeyOf = (models: ResolvedModels, classifierAlias: string, code: ClassifierCode): AutoGateKey => ({
  classifier: classifierAliasIdentityOf(models, classifierAlias),
  codeDigest: classifierCodeDigestOf(code),
  datasetDigest: AUTO_MODE_DATASET_DIGEST,
});

export const autoGateDirectoryOf = (home: string): string => path.join(layoutOf(home).state, 'auto-gate');

const RECORD_FILE_MODE = 0o600;

const RECORD_DIRECTORY_MODE = 0o700;

const isProportion = (value: unknown): value is AutoGateProportion =>
  isRecord(value) && typeof value['successes'] === 'number' && typeof value['trials'] === 'number' && typeof value['high'] === 'number';

const isKey = (value: unknown): value is AutoGateKey =>
  isRecord(value) && typeof value['classifier'] === 'string' && typeof value['codeDigest'] === 'string' && typeof value['datasetDigest'] === 'string';

const recordOf = (value: unknown, file: string): AutoGateRecord => {
  if (
    !isRecord(value) ||
    !isKey(value['key']) ||
    !Array.isArray(value['cases']) ||
    !value['cases'].every((entry) => isRecord(entry) && typeof entry['id'] === 'string' && typeof entry['meetsMinimum'] === 'boolean') ||
    !isProportion(value['falseAllow']) ||
    !isProportion(value['falseBlock']) ||
    typeof value['runs'] !== 'number' ||
    typeof value['unobserved'] !== 'number' ||
    typeof value['agentAlias'] !== 'string' ||
    typeof value['recordedAt'] !== 'string' ||
    typeof value['version'] !== 'string'
  ) {
    throw new ConfigError(`${file}: not an auto mode measurement record`);
  }
  return value as AutoGateRecord;
};

export const readAutoGateRecords = (directory: string): AutoGateRecord[] => {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (isAbsentPathError(error)) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      return recordOf(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, file);
    });
};

export const writeAutoGateRecord = async (directory: string, record: AutoGateRecord, randomHex: (bytes: number) => string): Promise<string> => {
  await fs.promises.mkdir(directory, { recursive: true, mode: RECORD_DIRECTORY_MODE });
  const file = path.join(directory, `${sha256Hex(canonicalJson(record.key))}.json`);
  await writeFileAtomically(file, `${JSON.stringify(record, null, 2)}\n`, { mode: RECORD_FILE_MODE, randomHex });
  return file;
};
