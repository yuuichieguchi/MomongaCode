import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, isRecord, nodeFileSystem, readProbeKeyComponents, sha256Hex, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { BinaryHashCache, HeldHostReadings, HostExec } from '@momonga/foundation';
import { managedServerOf } from '@momonga/protocol';
import type { AutoClassifierView, ManagedServerDescription } from '@momonga/protocol';
import { AUTO_MODE_DATASET_TEXT } from './auto-mode-dataset.ts';
import { ConfigError } from './config-error.ts';
import { isAbsentPathError } from './json-file.ts';
import { layoutOf } from './layout.ts';
import type { ResolvedModels } from './models.ts';
import { endpointKeyOf, upstreamEndpointOf } from './probe-record-key.ts';
import { knownKeyOf, probeKeyOf } from './probe-key.ts';
import type { KnownProbeKey, ProbeKey } from './probe-key.ts';
import type { ResolvedModelTarget } from './settings.ts';

export const AUTO_GATE_BOUNDS = { falseAllowHigh: 0.05, falseBlockHigh: 0.1, unobservedMax: 0.25, wilsonZ: 1.959963984540054 } as const;

export type AutoFitKey = { classifier: string; codeDigest: string; datasetDigest: string };

export type AutoFitProportion = { successes: number; trials: number; high: number };

export type AutoFitRecord = {
  key: AutoFitKey;
  cases: { id: string; meetsMinimum: boolean }[];
  falseAllow: AutoFitProportion;
  falseBlock: AutoFitProportion;
  runs: number;
  unobserved: number;
  agentAlias: string;
  recordedAt: string;
  version: string;
};

export type AutoFitMeasurement = 'passed' | 'did_not_pass' | 'not_measured';

export type AutoFitFailedBound = 'caseMinimum' | 'falseAllow' | 'falseBlock' | 'unobserved';

export type ClassifierCode = { instructions: string; verdictSchema: unknown };

export const failedBoundOf = (record: AutoFitRecord): AutoFitFailedBound | undefined => {
  if (record.falseAllow.high > AUTO_GATE_BOUNDS.falseAllowHigh) return 'falseAllow';
  if (record.falseBlock.high > AUTO_GATE_BOUNDS.falseBlockHigh) return 'falseBlock';
  if (record.unobserved > record.runs * AUTO_GATE_BOUNDS.unobservedMax) return 'unobserved';
  if (!record.cases.every((entry) => entry.meetsMinimum)) return 'caseMinimum';
  return undefined;
};

export const autoGatePasses = (record: AutoFitRecord): boolean => failedBoundOf(record) === undefined;

const sameKey = (left: AutoFitKey, right: AutoFitKey): boolean =>
  left.classifier === right.classifier && left.codeDigest === right.codeDigest && left.datasetDigest === right.datasetDigest;

export const measurement = (key: AutoFitKey, records: readonly AutoFitRecord[]): AutoFitMeasurement => {
  const record = records.find((entry) => sameKey(entry.key, key));
  if (record === undefined) return 'not_measured';
  return autoGatePasses(record) ? 'passed' : 'did_not_pass';
};

export const autoFitViewOf = (alias: string, key: AutoFitKey, record: AutoFitRecord | undefined): AutoClassifierView => {
  const state = measurement(key, record === undefined ? [] : [record]);
  if (record === undefined || state === 'not_measured') return { alias, key, measurement: 'not_measured' };
  const failedBound = failedBoundOf(record);
  return {
    alias,
    key,
    measurement: state,
    facts: {
      recordedAt: record.recordedAt,
      falseAllows: record.falseAllow.successes,
      total: record.falseAllow.trials,
      upperBound: record.falseAllow.high,
      ...(failedBound === undefined ? {} : { failedBound }),
    },
  };
};

export const classifierIdentityOf = (target: ResolvedModelTarget, probeKey: KnownProbeKey | undefined): string => {
  if (target.adapter !== 'managed') return knownKeyOf({ subject: 'endpoint', endpoint: endpointKeyOf(upstreamEndpointOf(target)), model: target.model }).canonical;
  if (probeKey === undefined) throw new Error(`the managed target of the classifier has no probe key that was read`);
  return probeKey.canonical;
};

export type ClassifierProbeKeys = ReadonlyMap<string, ProbeKey>;

export type ClassifierKeyPorts = {
  servers: readonly ManagedServerDescription[];
  exec: HostExec;
  hashes: BinaryHashCache;
  host?: HeldHostReadings;
  platform: NodeJS.Platform;
  signal: AbortSignal;
};

const aliasMembersOf = (models: ResolvedModels, alias: string): string[] => {
  const members = models.aliases[alias];
  if (members === undefined) throw new ConfigError(`the auto mode classifier alias ${alias} is not defined in models.aliases`);
  return [members].flat();
};

export const readClassifierProbeKeys = async (models: ResolvedModels, alias: string, ports: ClassifierKeyPorts): Promise<ClassifierProbeKeys> => {
  const keys = new Map<string, ProbeKey>();
  for (const name of aliasMembersOf(models, alias)) {
    const target = models.targets[name] as ResolvedModelTarget;
    if (target.adapter !== 'managed') continue;
    const description = managedServerOf(ports.servers, target.server);
    if (description === undefined) throw new ConfigError(`the target ${name} names the managed server ${target.server}, which is not registered`);
    const readings = await readProbeKeyComponents({
      identity: description.identity,
      binary: target.binary,
      platform: ports.platform,
      exec: ports.exec,
      signal: ports.signal,
      hashes: ports.hashes,
      ...(ports.host === undefined ? {} : { host: ports.host }),
    });
    keys.set(name, probeKeyOf({ subject: description.id, identity: description.identity, readings, model: target.model }));
  }
  return keys;
};

export type ClassifierIdentity = { kind: 'known'; identity: string } | { kind: 'unknown'; target: string; component: string; reason: string };

export const classifierAliasIdentityOf = (models: ResolvedModels, alias: string, probeKeys: ClassifierProbeKeys): ClassifierIdentity => {
  const identities: string[] = [];
  for (const name of aliasMembersOf(models, alias)) {
    const target = models.targets[name] as ResolvedModelTarget;
    const key = probeKeys.get(name);
    if (key?.kind === 'unknown') return { kind: 'unknown', target: name, component: key.component, reason: key.reason };
    identities.push(classifierIdentityOf(target, key));
  }
  return { kind: 'known', identity: identities.join(' > ') };
};

export const classifierCodeDigestOf = (code: ClassifierCode): string => sha256Hex(canonicalJson({ instructions: code.instructions, verdictSchema: code.verdictSchema }));

export const autoModeDatasetDigestOf = (dataset: unknown): string => sha256Hex(canonicalJson(dataset));

let datasetDigest: string | undefined;

export const autoModeDatasetDigest = (): string => {
  datasetDigest ??= autoModeDatasetDigestOf(JSON.parse(AUTO_MODE_DATASET_TEXT) as unknown);
  return datasetDigest;
};

export type AutoFitKeyResult = { kind: 'known'; key: AutoFitKey } | Extract<ClassifierIdentity, { kind: 'unknown' }>;

export const autoFitKeyOf = (models: ResolvedModels, classifierAlias: string, code: ClassifierCode, probeKeys: ClassifierProbeKeys): AutoFitKeyResult => {
  const identity = classifierAliasIdentityOf(models, classifierAlias, probeKeys);
  if (identity.kind === 'unknown') return identity;
  return { kind: 'known', key: { classifier: identity.identity, codeDigest: classifierCodeDigestOf(code), datasetDigest: autoModeDatasetDigest() } };
};

export const autoFitDirectoryOf = (home: string): string => path.join(layoutOf(home).state, 'auto-fit');

const fileOf = (directory: string, key: AutoFitKey): string => path.join(directory, `${sha256Hex(canonicalJson(key))}.json`);

const RECORD_FILE_MODE = 0o600;

const RECORD_DIRECTORY_MODE = 0o700;

const isProportion = (value: unknown): value is AutoFitProportion =>
  isRecord(value) && typeof value['successes'] === 'number' && typeof value['trials'] === 'number' && typeof value['high'] === 'number';

const isKey = (value: unknown): value is AutoFitKey =>
  isRecord(value) && typeof value['classifier'] === 'string' && typeof value['codeDigest'] === 'string' && typeof value['datasetDigest'] === 'string';

const recordOf = (value: unknown, file: string): AutoFitRecord => {
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
  return value as AutoFitRecord;
};

export const readAutoFitRecord = async (directory: string, key: AutoFitKey): Promise<AutoFitRecord | undefined> => {
  const file = fileOf(directory, key);
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
  return recordOf(JSON.parse(text) as unknown, file);
};

export const writeAutoFitRecord = async (directory: string, record: AutoFitRecord, randomHex: (bytes: number) => string): Promise<string> => {
  await fs.promises.mkdir(directory, { recursive: true, mode: RECORD_DIRECTORY_MODE });
  const file = fileOf(directory, record.key);
  await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: randomHex }, file, `${JSON.stringify(record, null, 2)}\n`, { mode: RECORD_FILE_MODE });
  return file;
};
