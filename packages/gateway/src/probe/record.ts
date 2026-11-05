import fs from 'node:fs';
import path from 'node:path';
import type { ProbeReport, ToolCallingMode, ToolCallingSetting } from '@momonga/protocol';
import { modeIsPrivate } from '@momonga/foundation';
import { decideToolCalling } from './decide.ts';
import { isRecord } from './json.ts';
import { missingRecordFailure } from './remedy.ts';
import { isProbeReport } from './report-schema.ts';

export interface ProbeRecordKey {
  target: string;
  binarySha256: string;
  osBuild: string;
}

const TARGET_PATTERN = /^[A-Za-z0-9._-]+$/;

const recordPath = (dir: string, target: string): string => {
  if (!TARGET_PATTERN.test(target) || target === '.' || target === '..') {
    throw new Error(`Invalid probe target name: ${target}`);
  }
  return path.join(dir, `${target}.json`);
};

const PRIVATE_DIRECTORY_MODE = 0o700;

export const writePrivateRecord = async (dir: string, file: string, content: string): Promise<void> => {
  await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!modeIsPrivate(await fs.promises.stat(dir), 'directory')) {
    await fs.promises.chmod(dir, PRIVATE_DIRECTORY_MODE);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporary, content, { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
};

export const saveProbeRecord = async (dir: string, key: ProbeRecordKey, report: ProbeReport): Promise<void> => {
  await writePrivateRecord(dir, recordPath(dir, key.target), JSON.stringify({ binarySha256: key.binarySha256, osBuild: key.osBuild, report }));
};

const corruptRecord = (file: string, key: ProbeRecordKey, problem: string, cause: unknown): Error =>
  new Error(
    `Probe record ${file} is unusable (${problem}). Delete it or re-run \`momonga gateway probe ${key.target}\`.`,
    { cause },
  );

export const loadProbeRecord = async (dir: string, key: ProbeRecordKey): Promise<ProbeReport | null> => {
  const file = recordPath(dir, key.target);
  const raw = await fs.promises.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corruptRecord(file, key, 'not valid JSON', error);
  }
  if (!isRecord(parsed)) throw corruptRecord(file, key, 'not an object', new TypeError('record is not an object'));
  if (typeof parsed['binarySha256'] !== 'string' || typeof parsed['osBuild'] !== 'string') {
    throw corruptRecord(file, key, 'missing key fields', new TypeError('binarySha256 or osBuild is missing'));
  }
  if (parsed['binarySha256'] !== key.binarySha256 || parsed['osBuild'] !== key.osBuild) return null;
  const report = parsed['report'];
  if (!isProbeReport(report)) {
    throw corruptRecord(file, key, 'invalid report', new TypeError('report does not match the probe report schema'));
  }
  return report;
};

export interface ResolvedToolCalling {
  mode: ToolCallingMode;
  source: 'config' | 'probed';
}

export const resolveToolCalling = (
  setting: ToolCallingSetting,
  report: ProbeReport | null,
  targetName: string,
): ResolvedToolCalling => {
  if (setting === 'native' || setting === 'constrained') return { mode: setting, source: 'config' };
  if (report === null) {
    throw missingRecordFailure(
      `the target "${targetName}" sets toolCalling to auto, but no probe record exists`,
      `no record for ${targetName}`,
      targetName,
    );
  }
  return { mode: decideToolCalling(report).mode, source: 'probed' };
};
