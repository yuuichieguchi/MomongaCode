import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ProbeReport } from '@momonga/protocol';
import { field, isRecord } from './json.ts';
import { writePrivateRecord } from './record.ts';
import { isProbeReport } from './report-schema.ts';

export type EndpointKey = { endpoint: string; model: string };

export type EndpointRecord = { identity: string; report: ProbeReport };

const FILE_NAME_HASH_CHARS = 32;

export const endpointRecordFileName = (key: EndpointKey): string =>
  `endpoint-${sha256Hex(canonicalJson([key.endpoint, key.model])).slice(0, FILE_NAME_HASH_CHARS)}.json`;

const fileOf = (dir: string, key: EndpointKey): string => path.join(dir, endpointRecordFileName(key));

export const endpointIdentityOf = (modelsBody: unknown, model: string): string => {
  const data = field(modelsBody, 'data');
  const listed = Array.isArray(data) ? data.find((entry) => field(entry, 'id') === model) : undefined;
  return listed === undefined ? '' : sha256Hex(canonicalJson(listed));
};

export const saveEndpointRecord = async (dir: string, key: EndpointKey, identity: string, report: ProbeReport): Promise<void> => {
  await writePrivateRecord(dir, fileOf(dir, key), JSON.stringify({ endpoint: key.endpoint, model: key.model, identity, report }));
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
  const report = parsed['report'];
  if (!isProbeReport(report)) throw unusable(file, 'invalid report');
  return { identity: parsed['identity'], report };
};
