import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { EndpointProbeReport, OllamaProbeReport, ProbeReport } from '@momonga/protocol';
import type { DialectCurrency } from '../dialect/candidates.ts';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import { isRecord, listedEntryOf } from './json.ts';
import { currentStamp, isCurrentRecord, writePrivateRecord } from './record.ts';
import { isEndpointProbeReport } from './report-schema.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

export type EndpointKey = { endpoint: string; model: string };

export type EndpointRecordOf<Report extends EndpointProbeReport> = { identity: string; identityFields: string[]; report: Report };

export type EndpointRecord = EndpointRecordOf<ProbeReport>;

export type OllamaEndpointRecord = EndpointRecordOf<OllamaProbeReport>;

export type StoredEndpointRecord = EndpointRecordOf<EndpointProbeReport>;

const FILE_NAME_HASH_CHARS = 32;

export const endpointRecordFileName = (key: EndpointKey): string =>
  `endpoint-${sha256Hex(canonicalJson([key.endpoint, key.model])).slice(0, FILE_NAME_HASH_CHARS)}.json`;

export type EndpointLockKey = { target: string; endpoint: string; model: string };

export const endpointLockKeyOf = (key: EndpointKey): EndpointLockKey => ({
  target: endpointRecordFileName(key).replace(/\.json$/, ''),
  endpoint: key.endpoint,
  model: key.model,
});

export const endpointKeyOfLock = (key: EndpointLockKey): EndpointKey => ({ endpoint: key.endpoint, model: key.model });

const fileOf = (dir: string, key: EndpointKey): string => path.join(dir, endpointRecordFileName(key));

export const requireListedEntry = (modelsBody: unknown, model: string): Record<string, unknown> => {
  const listed = listedEntryOf(modelsBody, model);
  if (listed === undefined) {
    throw new PreconditionFailedError(
      `the server does not list the model ${model}, so its identity cannot be measured`,
      'GET /v1/models has no entry whose id is the model of the target',
      'serve the model under an id that GET /v1/models lists, or declare the capabilities of the target instead of toolCalling auto',
    );
  }
  return listed;
};

export const stableIdentityFieldsOf = (firstBody: unknown, secondBody: unknown, model: string): string[] => {
  const first = listedEntryOf(firstBody, model);
  const second = listedEntryOf(secondBody, model);
  if (first === undefined || second === undefined) return [];
  return Object.keys(first)
    .filter((name) => name in second && canonicalJson(first[name]) === canonicalJson(second[name]))
    .sort();
};

export const endpointIdentityOf = (modelsBody: unknown, model: string, fields: readonly string[]): string => {
  const listed = requireListedEntry(modelsBody, model);
  return sha256Hex(canonicalJson(Object.fromEntries(fields.filter((name) => name in listed).map((name) => [name, listed[name]]))));
};

export const saveEndpointRecord = async (
  dir: string,
  key: EndpointKey,
  identity: string,
  identityFields: readonly string[],
  report: EndpointProbeReport,
  currency: DialectCurrency,
  lock: KernelLockMechanism,
): Promise<void> => {
  await writePrivateRecord(
    dir,
    fileOf(dir, key),
    JSON.stringify({ endpoint: key.endpoint, model: key.model, identity, identityFields, ...currentStamp(report, currency), report }),
    lock,
  );
};

const unusable = (file: string, problem: string): Error =>
  new Error(`Probe record ${file} is unusable (${problem}). Delete it or re-run \`momonga gateway probe\` for the target.`);

export const loadEndpointRecord = async (dir: string, key: EndpointKey, currency: DialectCurrency): Promise<StoredEndpointRecord | null> => {
  const file = fileOf(dir, key);
  const raw = await fs.promises.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unusable(file, 'not valid JSON');
  }
  if (!isRecord(parsed) || typeof parsed['identity'] !== 'string') throw unusable(file, 'missing key fields');
  if (parsed['endpoint'] !== key.endpoint || parsed['model'] !== key.model) throw unusable(file, 'it belongs to another endpoint or model');
  if (!isCurrentRecord(parsed, currency)) return null;
  const identityFields = parsed['identityFields'];
  if (!Array.isArray(identityFields) || !identityFields.every((name): name is string => typeof name === 'string')) {
    throw unusable(file, 'identityFields is not a list of field names');
  }
  const report = parsed['report'];
  if (!isEndpointProbeReport(report)) throw unusable(file, 'invalid report');
  return { identity: parsed['identity'], identityFields, report };
};

const isOllamaReport = (report: EndpointProbeReport): report is OllamaProbeReport => 'kind' in report && report.kind === 'ollama';

export const chatRecordOf = (record: StoredEndpointRecord | null, key: EndpointKey): EndpointRecord | null => {
  if (record === null) return null;
  const { report } = record;
  if (isOllamaReport(report)) {
    throw new Error(`The probe record for ${key.endpoint} and model ${key.model} was written by an ollama target; probe the chat-completions target again or delete the record.`);
  }
  return { ...record, report };
};

export const ollamaRecordOf = (record: StoredEndpointRecord | null, key: EndpointKey): OllamaEndpointRecord | null => {
  if (record === null) return null;
  const { report } = record;
  if (!isOllamaReport(report)) {
    throw new Error(`The probe record for ${key.endpoint} and model ${key.model} was not written by an ollama probe; run the probe for the ollama target again.`);
  }
  return { ...record, report };
};
