import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, isRecord, nodeFileSystem, readProbeKeyComponents, sha256Hex, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { BinaryHashCache, HeldHostReadings, HostExec } from '@momonga/foundation';
import type { AutoClassifierView } from '@momonga/protocol';
import { registeredServer } from './server-registry.ts';
import { AUTO_MODE_DATASET_TEXT } from './auto-mode-dataset.ts';
import { ConfigError, rethrowIfTransient } from './config-error.ts';
import { isAbsentPathError, parseJsonText } from './json-file.ts';
import { layoutOf } from './layout.ts';
import type { ResolvedModel, ResolvedModels } from './models.ts';
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
  agentModel: string;
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

export const autoFitViewOf = (model: string, key: AutoFitKey, record: AutoFitRecord | undefined): AutoClassifierView => {
  const state = measurement(key, record === undefined ? [] : [record]);
  if (record === undefined || state === 'not_measured') return { model, key, measurement: 'not_measured' };
  const failedBound = failedBoundOf(record);
  return {
    model,
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
  if (probeKey === undefined) throw new Error(`the managed server of the classifier model has no probe key that was read`);
  return probeKey.canonical;
};

export type ClassifierProbeKeys = ReadonlyMap<string, ProbeKey>;

export type ClassifierKeyPorts = {
  exec: HostExec;
  hashes: BinaryHashCache;
  host?: HeldHostReadings;
  platform: NodeJS.Platform;
  signal: AbortSignal;
};

const chainMembersOf = (models: ResolvedModels, classifier: string): ResolvedModel[] => {
  const chain = models.chains.get(classifier);
  if (chain === undefined) throw new TypeError(`the classifier model ${classifier} has no chain in the resolved models`);
  return chain.map((canon) => models.models.get(canon) as ResolvedModel);
};

export const readClassifierProbeKeys = async (models: ResolvedModels, classifier: string, ports: ClassifierKeyPorts): Promise<ClassifierProbeKeys> => {
  const keys = new Map<string, ProbeKey>();
  for (const member of chainMembersOf(models, classifier)) {
    if (member.adapter !== 'managed') continue;
    const description = registeredServer(models.servers, member.server);
    if (description === undefined) throw new ConfigError(`the model ${member.canon} names the managed server ${member.server}, which is not registered`);
    const readings = await readProbeKeyComponents({
      identity: description.identity,
      binary: member.binary,
      platform: ports.platform,
      exec: ports.exec,
      signal: ports.signal,
      hashes: ports.hashes,
      ...(ports.host === undefined ? {} : { host: ports.host }),
    });
    keys.set(member.canon, probeKeyOf({ subject: description.id, identity: description.identity, readings, model: member.model }));
  }
  return keys;
};

export type ClassifierIdentity = { kind: 'known'; identity: string } | { kind: 'unknown'; target: string; component: string; reason: string };

export const classifierChainIdentityOf = (models: ResolvedModels, classifier: string, probeKeys: ClassifierProbeKeys): ClassifierIdentity => {
  const identities: string[] = [];
  for (const member of chainMembersOf(models, classifier)) {
    const key = probeKeys.get(member.canon);
    if (key?.kind === 'unknown') return { kind: 'unknown', target: member.canon, component: key.component, reason: key.reason };
    identities.push(classifierIdentityOf(member, key));
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

export const autoFitKeyOf = (models: ResolvedModels, classifier: string, code: ClassifierCode, probeKeys: ClassifierProbeKeys): AutoFitKeyResult => {
  const identity = classifierChainIdentityOf(models, classifier, probeKeys);
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

const isMeasurement = (value: Record<string, unknown>): boolean =>
  isKey(value['key']) &&
  Array.isArray(value['cases']) &&
  value['cases'].every((entry) => isRecord(entry) && typeof entry['id'] === 'string' && typeof entry['meetsMinimum'] === 'boolean') &&
  isProportion(value['falseAllow']) &&
  isProportion(value['falseBlock']) &&
  typeof value['runs'] === 'number' &&
  typeof value['unobserved'] === 'number' &&
  typeof value['recordedAt'] === 'string' &&
  typeof value['version'] === 'string';

const recordOf = (value: unknown, file: string): AutoFitRecord | undefined => {
  if (!isRecord(value) || !isMeasurement(value)) throw new ConfigError(`${file}: not an auto mode measurement record`);
  return typeof value['agentModel'] === 'string' ? (value as AutoFitRecord) : undefined;
};

const recordTextOf = async (file: string): Promise<string | undefined> => {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    rethrowIfTransient(error);
    throw new ConfigError(`${file}: the auto mode measurement record cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};

export const readAutoFitRecord = async (directory: string, key: AutoFitKey): Promise<AutoFitRecord | undefined> => {
  const file = fileOf(directory, key);
  const text = await recordTextOf(file);
  return text === undefined ? undefined : recordOf(parseJsonText(text, file), file);
};

export const writeAutoFitRecord = async (directory: string, record: AutoFitRecord, randomHex: (bytes: number) => string): Promise<string> => {
  await fs.promises.mkdir(directory, { recursive: true, mode: RECORD_DIRECTORY_MODE });
  const file = fileOf(directory, record.key);
  await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: randomHex }, file, `${JSON.stringify(record, null, 2)}\n`, { mode: RECORD_FILE_MODE });
  return file;
};
