import fs from 'node:fs';
import path from 'node:path';
import { TEMP_DIR_PREFIX, stopSupervisorHolders } from '@momonga/testkit';
import { OWNER_FILE, ROOT_PREFIX, parseEvalOwner } from '../../packages/cli/src/eval/context-host.ts';
import { defaultLedgerPorts, killSelectedGroups, parsePidsFile, selectGroupsToSignal } from './ledger.ts';
import type { LedgerPorts } from './ledger.ts';
import { removeTree } from './remove-tree.ts';
import { KEPT_HOME_FILE_NAME, LIVE_MARKER_SUFFIX, PIDS_FILE_SUFFIX, e2eEntryPrefix, harnessFilePath, readHarnessFile, sharedTempBase } from './run-env.ts';

export type TeardownPorts = Pick<LedgerPorts, 'startTimeOf' | 'groupAlive' | 'pidAlive' | 'killGroups'>;

export type E2eTeardownOptions = { tmpRoot: string; run: string; evalBase?: string; sharedBase?: string; ports?: TeardownPorts; report?: (line: string) => void };

const HARNESS_SUFFIXES: readonly string[] = [PIDS_FILE_SUFFIX, LIVE_MARKER_SUFFIX];

export const leftoverEntries = (listing: readonly string[], run: string): string[] => {
  const e2ePrefix = e2eEntryPrefix(run);
  const harnessEntries = new Set(HARNESS_SUFFIXES.map((suffix) => `${e2ePrefix}${suffix}`));
  return listing.filter((entry) => entry.startsWith(e2ePrefix) && !harnessEntries.has(entry));
};

export const leakedTestkitEntries = (listing: readonly string[], run: string): string[] => {
  const testkitPrefix = `${TEMP_DIR_PREFIX}${run}-`;
  return listing.filter((entry) => entry.startsWith(testkitPrefix));
};

export const killListedGroups = async (pidsFile: string, ports: TeardownPorts = defaultLedgerPorts): Promise<number[]> => {
  let text: string;
  try {
    text = readHarnessFile(pidsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const firstSeen = new Map(parsePidsFile(text).map((entry) => [entry.pgid, entry] as const).reverse());
  const { signal } = await selectGroupsToSignal([...firstSeen.values()], ports);
  await killSelectedGroups(signal, ports);
  return signal;
};

const ABSENT_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR']);

export const evalRootsOfRun = (base: string, tmpRoot: string, run: string): string[] => {
  const homePrefix = e2eEntryPrefix(run);
  const roots: string[] = [];
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const root = path.join(base, name);
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, OWNER_FILE), 'utf8');
    } catch (error) {
      if (ABSENT_CODES.has((error as NodeJS.ErrnoException).code)) continue;
      throw error;
    }
    const owner = parseEvalOwner(text);
    if (owner !== undefined && path.dirname(owner.home) === tmpRoot && path.basename(owner.home).startsWith(homePrefix)) roots.push(root);
  }
  return roots;
};

export const runE2eTeardown = async (options: E2eTeardownOptions): Promise<void> => {
  const { tmpRoot, run, ports = defaultLedgerPorts, report = (line: string) => console.error(line), evalBase = sharedTempBase(), sharedBase = sharedTempBase() } = options;
  const killed = await killListedGroups(harnessFilePath(tmpRoot, run, PIDS_FILE_SUFFIX), ports);
  const left = leftoverEntries(fs.readdirSync(tmpRoot), run).map((entry) => path.join(tmpRoot, entry));
  const keptTests = new Map(left.flatMap((directory) => {
    const file = path.join(directory, KEPT_HOME_FILE_NAME);
    return fs.existsSync(file) ? [[directory, fs.readFileSync(file, 'utf8').trim()] as const] : [];
  }));
  const leaked = left.filter((directory) => !keptTests.has(directory));
  const leakedEval = evalRootsOfRun(evalBase, tmpRoot, run);
  const leakedTestkit = leakedTestkitEntries(fs.readdirSync(sharedBase), run).map((entry) => path.join(sharedBase, entry));
  for (const [directory, test] of keptTests) report(`e2e teardown: kept the home of the failed test ${test} at ${directory}`);
  if (killed.length > 0) report(`e2e teardown: killed process groups left by run ${run}: ${killed.join(', ')}`);
  for (const directory of [...leaked, ...leakedEval]) report(`e2e teardown: leaked directory ${directory}`);
  for (const directory of leakedTestkit) report(`e2e teardown: leaked testkit directory ${directory}, left in place outside the private e2e directory`);
  for (const directory of [...leaked, ...leakedEval]) {
    await stopSupervisorHolders(directory);
    removeTree(directory);
  }
  for (const suffix of HARNESS_SUFFIXES) fs.rmSync(harnessFilePath(tmpRoot, run, suffix), { force: true });
  const directories = leaked.length + leakedEval.length + leakedTestkit.length;
  if (killed.length > 0 || directories > 0) {
    throw new Error(`e2e leak guard: run ${run} left ${killed.length} process group(s) and ${directories} director(ies)`);
  }
};
