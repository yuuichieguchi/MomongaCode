import fs from 'node:fs';
import path from 'node:path';
import { TEMP_DIR_PREFIX } from '@momonga/testkit';
import { defaultLedgerPorts, killSelectedGroups, parsePidsFile, selectGroupsToSignal } from './ledger.ts';
import type { LedgerPorts } from './ledger.ts';
import { removeTree } from './remove-tree.ts';
import { LIVE_MARKER_SUFFIX, PIDS_FILE_SUFFIX, e2eEntryPrefix, harnessFilePath } from './run-env.ts';

export type TeardownPorts = Pick<LedgerPorts, 'startTimeOf' | 'groupAlive' | 'pidAlive' | 'killGroups'>;

export type E2eTeardownOptions = { tmpRoot: string; run: string; ports?: TeardownPorts; report?: (line: string) => void };

const HARNESS_SUFFIXES: readonly string[] = [PIDS_FILE_SUFFIX, LIVE_MARKER_SUFFIX];

export const leftoverEntries = (listing: readonly string[], run: string): string[] => {
  const e2ePrefix = e2eEntryPrefix(run);
  const harnessEntries = new Set(HARNESS_SUFFIXES.map((suffix) => `${e2ePrefix}${suffix}`));
  const testkitPrefix = `${TEMP_DIR_PREFIX}${run}-`;
  return listing.filter((entry) => (entry.startsWith(e2ePrefix) && !harnessEntries.has(entry)) || entry.startsWith(testkitPrefix));
};

export const killListedGroups = async (pidsFile: string, ports: TeardownPorts = defaultLedgerPorts): Promise<number[]> => {
  let text: string;
  try {
    text = fs.readFileSync(pidsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const firstSeen = new Map(parsePidsFile(text).map((entry) => [entry.pgid, entry] as const).reverse());
  const { signal } = await selectGroupsToSignal([...firstSeen.values()], ports);
  await killSelectedGroups(signal, ports);
  return signal;
};

export const runE2eTeardown = async (options: E2eTeardownOptions): Promise<void> => {
  const { tmpRoot, run, ports = defaultLedgerPorts, report = (line: string) => console.error(line) } = options;
  const killed = await killListedGroups(harnessFilePath(tmpRoot, run, PIDS_FILE_SUFFIX), ports);
  const leaked = leftoverEntries(fs.readdirSync(tmpRoot), run);
  if (killed.length > 0) report(`e2e teardown: killed process groups left by run ${run}: ${killed.join(', ')}`);
  for (const entry of leaked) report(`e2e teardown: leaked directory ${entry} in ${tmpRoot}`);
  for (const entry of leaked) removeTree(path.join(tmpRoot, entry));
  for (const suffix of HARNESS_SUFFIXES) fs.rmSync(harnessFilePath(tmpRoot, run, suffix), { force: true });
  if (killed.length > 0 || leaked.length > 0) {
    throw new Error(`e2e leak guard: run ${run} left ${killed.length} process group(s) and ${leaked.length} director(ies)`);
  }
};
