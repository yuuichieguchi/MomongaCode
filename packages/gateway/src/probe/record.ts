import fs from 'node:fs';
import path from 'node:path';
import type { NeedsProbe, ProbeReport, ToolCallingMode, ToolCallingSetting } from '@momonga/protocol';
import { canonicalJson, modeIsPrivate, nodeFileSystem, systemRandom, writeFileAtomically } from '@momonga/foundation';
import { dialectsDigest } from '../dialect/candidates.ts';
import type { DialectCurrency } from '../dialect/candidates.ts';
import { decideToolCalling } from './decide.ts';
import { isRecord } from './json.ts';
import { preconditionOf } from './remedy.ts';
import { isProbeReport } from './report-schema.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

export const recordForIdentity = <Stored>(stored: Stored, storedIdentity: Readonly<Record<string, unknown>>, currentIdentity: Readonly<Record<string, unknown>>): Stored | null =>
  canonicalJson(storedIdentity) === canonicalJson(currentIdentity) ? stored : null;

export type ManagedRecordKey = { readonly canonical: string; readonly digest: string };

export type ManagedRecordCurrency = DialectCurrency & { descriptionDigest: string };

export const managedRecordPath = (dir: string, key: ManagedRecordKey): string => path.join(dir, `${key.digest}.json`);

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_RECORD_MODE = 0o600;

export const ensurePrivateProbeDirectory = async (dir: string): Promise<void> => {
  await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!modeIsPrivate(await fs.promises.stat(dir), 'directory')) {
    await fs.promises.chmod(dir, PRIVATE_DIRECTORY_MODE);
  }
};

export const writePrivateRecord = async (dir: string, file: string, content: string, lock: KernelLockMechanism): Promise<void> => {
  await ensurePrivateProbeDirectory(dir);
  await writeFileAtomically(nodeFileSystem, systemRandom, file, content, { mode: PRIVATE_RECORD_MODE, lock });
};

export const currentStamp = (report: Pick<ProbeReport, 'schemaDialect'>, currency: DialectCurrency): { probeMethod: number; dialectsDigest: string | undefined } => ({
  probeMethod: currency.probeMethod,
  dialectsDigest: dialectsDigest(report.schemaDialect, currency),
});

export const isCurrentRecord = (stored: Record<string, unknown>, currency: DialectCurrency): boolean => {
  if (stored['probeMethod'] !== currency.probeMethod || typeof stored['dialectsDigest'] !== 'string') return false;
  const report = stored['report'];
  const dialect = isRecord(report) ? report['schemaDialect'] : undefined;
  const selected = isRecord(dialect) ? dialect['selected'] : undefined;
  if (selected !== null && typeof selected !== 'string') return false;
  return dialectsDigest({ selected }, currency) === stored['dialectsDigest'];
};

export const saveProbeRecord = async (dir: string, key: ManagedRecordKey, report: ProbeReport, currency: ManagedRecordCurrency, lock: KernelLockMechanism): Promise<void> => {
  await writePrivateRecord(dir, managedRecordPath(dir, key), JSON.stringify({ key: key.canonical, descriptionDigest: currency.descriptionDigest, ...currentStamp(report, currency), report }), lock);
};

const corruptRecord = (file: string, target: string, problem: string, cause: unknown): Error =>
  new Error(`Probe record ${file} is unusable (${problem}). Delete it or run "/gateway probe ${target}" in MomongaCode.`, { cause });

export const loadProbeRecord = async (dir: string, key: ManagedRecordKey, currency: ManagedRecordCurrency, target: string): Promise<ProbeReport | null> => {
  const file = managedRecordPath(dir, key);
  const raw = await fs.promises.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corruptRecord(file, target, 'not valid JSON', error);
  }
  if (!isRecord(parsed)) throw corruptRecord(file, target, 'not an object', new TypeError('record is not an object'));
  if (typeof parsed['key'] !== 'string') throw corruptRecord(file, target, 'missing key fields', new TypeError('key is missing'));
  if (typeof parsed['descriptionDigest'] !== 'string') return null;
  const matching = recordForIdentity(parsed, { key: parsed['key'] }, { key: key.canonical });
  if (matching === null || matching['descriptionDigest'] !== currency.descriptionDigest || !isCurrentRecord(matching, currency)) return null;
  const report = parsed['report'];
  if (!isProbeReport(report)) throw corruptRecord(file, target, 'invalid report', new TypeError('report does not match the probe report schema'));
  return report;
};

export interface ResolvedToolCalling {
  mode: ToolCallingMode;
  source: 'config' | 'probed';
}

export const resolveToolCalling = (
  setting: ToolCallingSetting,
  report: ProbeReport | null,
  needsProbe: NeedsProbe,
): ResolvedToolCalling => {
  if (setting === 'native' || setting === 'constrained') return { mode: setting, source: 'config' };
  if (report === null) throw preconditionOf(needsProbe);
  return { mode: decideToolCalling(report).mode, source: 'probed' };
};
