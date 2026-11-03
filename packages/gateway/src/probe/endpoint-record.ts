import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ProbeReport } from '@momonga/protocol';
import { field, isRecord } from './json.ts';
import { writePrivateRecord } from './record.ts';
import { isProbeReport } from './report-schema.ts';

export type EndpointKey = { endpoint: string; model: string };

export type EndpointRecord = { identity: string; identityFields: string[]; report: ProbeReport };

const FILE_NAME_HASH_CHARS = 32;

export const endpointRecordFileName = (key: EndpointKey): string =>
  `endpoint-${sha256Hex(canonicalJson([key.endpoint, key.model])).slice(0, FILE_NAME_HASH_CHARS)}.json`;

const fileOf = (dir: string, key: EndpointKey): string => path.join(dir, endpointRecordFileName(key));

const listedEntryOf = (modelsBody: unknown, model: string): Record<string, unknown> | undefined => {
  const data = field(modelsBody, 'data');
  const listed: unknown = Array.isArray(data) ? data.find((entry) => field(entry, 'id') === model) : undefined;
  return isRecord(listed) ? listed : undefined;
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
  const listed = listedEntryOf(modelsBody, model);
  if (listed === undefined) return '';
  return sha256Hex(canonicalJson(Object.fromEntries(fields.filter((name) => name in listed).map((name) => [name, listed[name]]))));
};

export const saveEndpointRecord = async (
  dir: string,
  key: EndpointKey,
  identity: string,
  identityFields: readonly string[],
  report: ProbeReport,
): Promise<void> => {
  await writePrivateRecord(
    dir,
    fileOf(dir, key),
    JSON.stringify({ endpoint: key.endpoint, model: key.model, identity, identityFields, report }),
  );
};

const unusable = (file: string, problem: string): Error =>
  new Error(`Probe record ${file} is unusable (${problem}). Delete it or re-run \`momonga gateway probe\` for the target.`);

export const loadEndpointRecord = async (dir: string, key: EndpointKey): Promise<EndpointRecord | null> => {
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
  const identityFields = parsed['identityFields'];
  if (!Array.isArray(identityFields) || !identityFields.every((name): name is string => typeof name === 'string')) {
    throw unusable(file, 'identityFields is not a list of field names');
  }
  const report = parsed['report'];
  if (!isProbeReport(report)) throw unusable(file, 'invalid report');
  return { identity: parsed['identity'], identityFields, report };
};
