import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../formal/reuse.ts';
import { OBSERVED_DIR, REUSE_STORE, TEST_REUSE_ENV, testReuseModeOf } from './reuse-observed.ts';

export { OBSERVED_DIR, REUSE_STORE, TEST_REUSE_ENV, observedFileOf, testReuseModeOf } from './reuse-observed.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const REUSE_RECORD_FORMAT = 'momonga-test-reuse/2';

export const WHOLE_RUN_ENV = 'MOMONGA_WHOLE_RUN';

export type ReuseGlobals = {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly harness: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly env: Readonly<Record<string, string>>;
};

export type RepoDigests = { digestOf(file: string): string; treeDigest(): string };

export type ReuseRecord = {
  readonly format: typeof REUSE_RECORD_FORMAT;
  readonly project: string;
  readonly file: string;
  readonly whole: boolean;
  readonly inputs: readonly string[];
  readonly key: string;
};

export type Observation = { readonly project: string; readonly file: string; readonly inputs: readonly string[]; readonly whole: boolean };

const harnessOfProject = (globals: ReuseGlobals, project: string): Readonly<Record<string, string>> => {
  const harness = globals.harness[project];
  if (harness === undefined) throw new Error(`the test reuse plan has no harness files for project ${project}`);
  return harness;
};

const keyOf = (globals: ReuseGlobals, project: string, file: string, inputs: readonly string[], whole: boolean, digests: RepoDigests): string =>
  sha256Hex(
    canonicalJson({
      format: REUSE_RECORD_FORMAT,
      globals: { ...globals, harness: harnessOfProject(globals, project) },
      project,
      file,
      inputs: [...inputs].sort().map((input) => [input, digests.digestOf(input)]),
      tree: whole ? digests.treeDigest() : null,
    }),
  );

export const recordFor = (observation: Observation, digests: RepoDigests, globals: ReuseGlobals): ReuseRecord => {
  const inputs = [...new Set(observation.inputs)].sort();
  return { format: REUSE_RECORD_FORMAT, project: observation.project, file: observation.file, whole: observation.whole, inputs, key: keyOf(globals, observation.project, observation.file, inputs, observation.whole, digests) };
};

export const isReplayable = (record: ReuseRecord, digests: RepoDigests, globals: ReuseGlobals): boolean => record.key === keyOf(globals, record.project, record.file, record.inputs, record.whole, digests);

const OUTSIDE = new Set(['node_modules', '.git']);

export const inputsOf = (root: string, paths: readonly string[]): string[] => {
  const store = REUSE_STORE.split(path.sep).join('/');
  const inputs = paths.flatMap((file) => {
    if (file.includes('\0')) return [];
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
    const posix = relative.split(path.sep).join('/');
    const first = posix.split('/')[0] ?? '';
    if (OUTSIDE.has(first) || posix === store || posix.startsWith(`${store}/`)) return [];
    return [posix];
  });
  return [...new Set(inputs)].sort();
};

const NO_FILE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']);

const digestOfPath = (file: string): string => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && NO_FILE_CODES.has(code)) return 'absent';
    throw error;
  }
  if (stat.isDirectory()) return `dir:${sha256Hex(fs.readdirSync(file).sort().join('\n'))}`;
  if (stat.isFile()) return `file:${sha256Hex(fs.readFileSync(file))}`;
  return `other:${stat.mode}`;
};

export const createRepoDigests = (root: string, tracked: readonly string[]): RepoDigests => {
  const snapshot = new Map(tracked.map((file) => [file, digestOfPath(path.join(root, file))] as const));
  const tree = sha256Hex(canonicalJson([...snapshot.entries()].sort(([left], [right]) => (left < right ? -1 : 1))));
  return {
    digestOf: (file) => snapshot.get(file) ?? digestOfPath(path.join(root, file)),
    treeDigest: () => tree,
  };
};

export const trackedFilesOf = (root: string): string[] => execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter((file) => file !== '');

export const HARNESS_INPUTS = ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'] as const;

export type HarnessSpec = { readonly shared: readonly string[]; readonly projects: Readonly<Record<string, readonly string[]>> };

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const WORKSPACE_SCOPE = '@momonga/';

const EXPORT_CONDITIONS = ['development', 'import', 'node', 'default'] as const;

const exportTargetOf = (target: unknown): string | undefined => {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null) return undefined;
  const conditions = target as Readonly<Record<string, unknown>>;
  const condition = EXPORT_CONDITIONS.find((name) => name in conditions);
  return condition === undefined ? undefined : exportTargetOf(conditions[condition]);
};

const workspaceEntriesOf = (root: string): ReadonlyMap<string, string> => {
  const entries = new Map<string, string>();
  for (const dir of fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    const manifest = path.join(root, 'packages', dir.name, 'package.json');
    if (!dir.isDirectory() || !fs.existsSync(manifest)) continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || typeof parsed.name !== 'string' || !('exports' in parsed)) continue;
    const exported: unknown = parsed.exports;
    if (typeof exported !== 'object' || exported === null) throw new Error(`${manifest}: exports is not a map of subpaths`);
    for (const [subpath, target] of Object.entries(exported)) {
      const file = exportTargetOf(target);
      if (file === undefined) throw new Error(`${manifest}: the export ${subpath} names no path for the conditions ${EXPORT_CONDITIONS.join(', ')}`);
      entries.set(subpath === '.' ? parsed.name : `${parsed.name}${subpath.slice(1)}`, path.join(root, 'packages', dir.name, file));
    }
  }
  return entries;
};

const importsOf = (file: string, workspace: ReadonlyMap<string, string>): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)].flatMap(([, specifier = '']) => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) return /\.[cm]?[jt]sx?$/.test(specifier) ? [path.resolve(path.dirname(file), specifier)] : [];
    if (!specifier.startsWith(WORKSPACE_SCOPE)) return [];
    const entry = workspace.get(specifier);
    if (entry === undefined) throw new Error(`${file} imports ${specifier}, which no workspace package exports`);
    return [entry];
  });

const closureOf = (root: string, entries: readonly string[], workspace: ReadonlyMap<string, string>): string[] => {
  const seen = new Set<string>(entries.map((entry) => path.join(root, entry)));
  let frontier = [...seen];
  while (frontier.length > 0) {
    const next = frontier.flatMap((file) => (/\.[cm]?[jt]sx?$/.test(file) ? importsOf(file, workspace) : [])).filter((file) => !seen.has(file));
    for (const file of next) seen.add(file);
    frontier = [...new Set(next)];
  }
  return [...seen].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
};

export const harnessOf = (root: string, spec: HarnessSpec): Record<string, string[]> => {
  const workspace = workspaceEntriesOf(root);
  const shared = closureOf(root, spec.shared, workspace);
  return Object.fromEntries(Object.entries(spec.projects).map(([project, entries]) => [project, [...new Set([...shared, ...closureOf(root, entries, workspace)])].sort()]));
};

const IGNORED_ENV = new Set([TEST_REUSE_ENV, WHOLE_RUN_ENV, 'MOMONGA_TLC_REUSE', 'MOMONGA_RUN_LOCK_WAIT_SECONDS', 'MOMONGA_RUN_CPU_BUDGET_SECONDS']);

export const globalsOf = (harness: Readonly<Record<string, readonly string[]>>, digests: RepoDigests, env: Env): ReuseGlobals => ({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  harness: Object.fromEntries(Object.entries(harness).map(([project, files]) => [project, Object.fromEntries([...files].sort().map((file) => [file, digests.digestOf(file)]))])),
  env: Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[0].startsWith('MOMONGA_') && !IGNORED_ENV.has(entry[0]) && entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  ),
});

export const replayedLine = (count: number): string => `Replayed ${count} test files, unchanged since their last green run on this machine`;

export const recordFileOf = (root: string, project: string, file: string): string => path.join(root, REUSE_STORE, project, `${sha256Hex(file)}.json`);

const isRecord = (value: unknown): value is ReuseRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return fields['format'] === REUSE_RECORD_FORMAT && typeof fields['project'] === 'string' && typeof fields['file'] === 'string' && typeof fields['whole'] === 'boolean' && typeof fields['key'] === 'string' && Array.isArray(fields['inputs']) && fields['inputs'].every((input) => typeof input === 'string');
};

const RECORD_FORMAT_FAMILY = 'momonga-test-reuse/';

const isOtherFormat = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'format' in value && typeof value.format === 'string' && value.format.startsWith(RECORD_FORMAT_FAMILY) && value.format !== REUSE_RECORD_FORMAT;

export const readRecord = (file: string): ReuseRecord | undefined => {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (isOtherFormat(parsed)) return undefined;
  if (!isRecord(parsed)) throw new Error(`${file} is not a ${REUSE_RECORD_FORMAT} record`);
  return parsed;
};

export const writeRecord = (file: string, record: ReuseRecord): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temporary, file);
};

export type ReusePlan = {
  readonly mode: 'on' | 'off';
  readonly root: string;
  readonly digests: RepoDigests;
  readonly globals: ReuseGlobals;
  readonly replayed: ReadonlyMap<string, readonly string[]>;
};

const recordsOfProject = (root: string, project: string): ReuseRecord[] => {
  const dir = path.join(root, REUSE_STORE, project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).flatMap((name) => readRecord(path.join(dir, name)) ?? []);
};

const PLAN = Symbol.for('momonga.testReusePlan');

type PlanHolder = { [PLAN]?: ReusePlan };

const planOf = (root: string, spec: HarnessSpec, env: Env): ReusePlan => {
  const mode = testReuseModeOf(env);
  const projects = Object.keys(spec.projects);
  if (mode === 'off') return { mode, root, digests: { digestOf: () => 'absent', treeDigest: () => '' }, globals: globalsOf({}, { digestOf: () => 'absent', treeDigest: () => '' }, env), replayed: new Map() };
  const tracked = trackedFilesOf(root);
  const digests = createRepoDigests(root, tracked);
  const globals = globalsOf(harnessOf(root, spec), digests, env);
  const replayed = new Map(projects.map((project) => [project, recordsOfProject(root, project).filter((record) => record.project === project && isReplayable(record, digests, globals)).map((record) => record.file).sort()] as const));
  return { mode, root, digests, globals, replayed };
};

export const testReusePlan = (root: string, spec: HarnessSpec, env: Env = process.env): ReusePlan => {
  const holder = globalThis as PlanHolder;
  holder[PLAN] ??= planOf(root, spec, env);
  return holder[PLAN];
};

export const currentTestReusePlan = (): ReusePlan => {
  const plan = (globalThis as PlanHolder)[PLAN];
  if (plan === undefined) throw new Error('no test reuse plan was made; vitest.config.ts makes it when it loads');
  return plan;
};

const VALUE_OPTIONS = new Set(['--project', '-t', '--testNamePattern', '--reporter', '--config', '-c', '--root', '-r', '--dir']);

export const fileFiltersOf = (argv: readonly string[]): string[] => {
  const run = argv.indexOf('run');
  const words = run === -1 ? [] : argv.slice(run + 1);
  return words.filter((word, index) => !word.startsWith('-') && !VALUE_OPTIONS.has(words[index - 1] ?? ''));
};

export const replayedSelected = (replayed: ReadonlyMap<string, readonly string[]>, projects: readonly string[], filters: readonly string[]): number =>
  [...replayed.entries()]
    .filter(([project]) => projects.length === 0 || projects.includes(project))
    .flatMap(([, files]) => files)
    .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter))).length;

export const projectsOf = (argv: readonly string[]): string[] => argv.flatMap((word, index) => (argv[index - 1] === '--project' ? [word] : word.startsWith('--project=') ? [word.slice('--project='.length)] : []));
