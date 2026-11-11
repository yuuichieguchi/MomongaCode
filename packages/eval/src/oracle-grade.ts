import path from 'node:path';
import type { WorkspaceFiles } from './files.ts';
import type { OracleCheck } from './oracle-check.ts';

export type WorkspaceProbe = {
  run(command: string, timeoutMs: number, cwd: string): Promise<{ exitCode: number | null; timedOut: boolean }>;
  digest(cwd: string, paths: readonly string[]): Promise<string>;
  changedPaths(cwd: string, baseDir: string): Promise<string[]>;
};

export type CheckResult = { id: string; passed: boolean; reason?: 'timeout' | 'exit' | 'changed' | 'out_of_scope' };

export type TrialGrade = { met: boolean; checks: CheckResult[] };

export type ChecksInput = { checks: readonly OracleCheck[]; graderFiles: Readonly<Record<string, string>>; workspace: string; base: string; probe: WorkspaceProbe; files: WorkspaceFiles };

type Location = Pick<ChecksInput, 'workspace' | 'base' | 'probe' | 'files'>;

const segmentsOf = (entry: string): string[] | undefined => {
  const segments = entry.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.includes('..') ? undefined : segments;
};

const within = (changed: string, allowed: string): boolean => {
  const target = segmentsOf(changed);
  const root = segmentsOf(allowed);
  return target !== undefined && root !== undefined && root.length <= target.length && root.every((segment, index) => segment === target[index]);
};

export const filesUnder = async (files: WorkspaceFiles, root: string, relative: string): Promise<string[]> => {
  const stat = await files.lstat(path.join(root, relative)).then(
    (found) => found,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (stat === undefined || !stat.isDirectory()) return stat === undefined ? [] : [relative];
  const children = await files.readdir(path.join(root, relative));
  const nested = await Promise.all(children.sort().map((child) => filesUnder(files, root, relative === '' ? child : path.posix.join(relative, child))));
  return nested.flat();
};

const filesOfPaths = async (files: WorkspaceFiles, paths: readonly string[], roots: readonly string[]): Promise<string[]> => {
  const found = await Promise.all(paths.flatMap((entry) => roots.map((root) => filesUnder(files, root, entry.replace(/\/$/, '')))));
  return [...new Set(found.flat())].sort();
};

const pathCheck = async (check: Exclude<OracleCheck, { kind: 'command' }>, { workspace, base, probe, files }: Location): Promise<CheckResult> => {
  if (check.kind === 'unchangedPaths') {
    const unchanged = await filesOfPaths(files, check.paths, [workspace, base]);
    const [after, before] = await Promise.all([probe.digest(workspace, unchanged), probe.digest(base, unchanged)]);
    return after === before ? { id: check.id, passed: true } : { id: check.id, passed: false, reason: 'changed' };
  }
  const changed = await probe.changedPaths(workspace, base);
  const stray = changed.some((entry) => !check.paths.some((allowed) => within(entry, allowed)));
  return stray ? { id: check.id, passed: false, reason: 'out_of_scope' } : { id: check.id, passed: true };
};

const commandCheck = async (check: Extract<OracleCheck, { kind: 'command' }>, { workspace, probe }: Location): Promise<CheckResult> => {
  const outcome = await probe.run(check.run, check.timeoutMs, workspace);
  if (outcome.timedOut) return { id: check.id, passed: false, reason: 'timeout' };
  return outcome.exitCode === check.expectExit ? { id: check.id, passed: true } : { id: check.id, passed: false, reason: 'exit' };
};

const writeGraderFiles = async (files: WorkspaceFiles, graderFiles: Readonly<Record<string, string>>, workspace: string): Promise<void> => {
  for (const [relative, content] of Object.entries(graderFiles)) {
    await files.mkdir(path.dirname(path.join(workspace, relative)));
    await files.writeFile(path.join(workspace, relative), content);
  }
};

export const gradeChecks = async (input: ChecksInput): Promise<TrialGrade> => {
  const pathResults = new Map<string, CheckResult>();
  for (const check of input.checks) {
    if (check.kind !== 'command') pathResults.set(check.id, await pathCheck(check, input));
  }
  await writeGraderFiles(input.files, input.graderFiles, input.workspace);
  const checks: CheckResult[] = [];
  for (const check of input.checks) {
    const result = check.kind === 'command' ? await commandCheck(check, input) : pathResults.get(check.id);
    if (result === undefined) throw new Error(`oracle check ${check.id} produced no result`);
    checks.push(result);
  }
  return { met: checks.every((check) => check.passed), checks };
};
