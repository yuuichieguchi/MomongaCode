import fs from 'node:fs';

export const MANIFEST_FORMAT = 'momonga-tla-manifest/1';

export type Tier = 'every-run' | 'deep';

export type Role = 'check' | 'evidence';

export type Violation = { readonly violates: string; readonly exitCode: 12 | 13 };

export type Expectation = 'holds' | Violation;

export type ManifestEntry = {
  readonly config: string;
  readonly role: Role;
  readonly expect: Expectation;
  readonly args: readonly string[];
  readonly tier: Tier;
  readonly distinctStates: number;
  readonly measuredSeconds: number;
  readonly measuredCpuSeconds: number;
  readonly budgetCpuSeconds: number;
};

export type Manifest = {
  readonly format: typeof MANIFEST_FORMAT;
  readonly unitSuiteSeconds: number;
  readonly startupCpuSeconds: number;
  readonly entries: readonly ManifestEntry[];
};

export type TlcRun = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly killedAtCpuBudget: boolean;
  readonly metadir: string;
  readonly stdout: string;
  readonly stderr: string;
};

export type TlcRunOptions = {
  readonly script: string;
  readonly config: string;
  readonly args: readonly string[];
  readonly budgetCpuSeconds: number;
  readonly env?: Readonly<Record<string, string>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const refuse = (where: string, rule: string): never => {
  throw new Error(`the TLA manifest is invalid: ${where} ${rule}`);
};

const fail = (where: string, expectation: string): never => refuse(where, `must be ${expectation}`);

const positiveNumber = (value: unknown, where: string): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fail(where, 'a positive number'));

const positiveInteger = (value: unknown, where: string): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fail(where, 'a positive whole number'));

const textOf = (value: unknown, where: string): string => (typeof value === 'string' && value.length > 0 ? value : fail(where, 'a non-empty string'));

const CONFIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const configNameOf = (value: unknown, where: string): string => {
  const name = textOf(value, where);
  return CONFIG_NAME.test(name) ? name : fail(where, 'a name made of letters, digits, ".", "_" and "-" that starts with a letter or a digit');
};

const ACCEPTED_ARGS: readonly (readonly string[])[] = [[], ['-lncheck', 'final']];

const sameWords = (accepted: readonly string[], given: readonly unknown[]): boolean => accepted.length === given.length && accepted.every((word, index) => given[index] === word);

const expectationOf = (value: unknown, where: string): Expectation => {
  if (value === 'holds') return value;
  if (!isRecord(value)) return fail(where, '"holds" or { violates, exitCode }');
  const exitCode = value['exitCode'];
  if (exitCode !== 12 && exitCode !== 13) return fail(`${where}.exitCode`, '12 or 13');
  return { violates: textOf(value['violates'], `${where}.violates`), exitCode };
};

const entryOf = (value: unknown, index: number, startupCpuSeconds: number): ManifestEntry => {
  const where = `entries[${index}]`;
  if (!isRecord(value)) return fail(where, 'an object');
  const { role, tier, args } = value;
  if (role !== 'check' && role !== 'evidence') return fail(`${where}.role`, '"check" or "evidence"');
  if (tier !== 'every-run' && tier !== 'deep') return fail(`${where}.tier`, '"every-run" or "deep"');
  if (!Array.isArray(args) || !ACCEPTED_ARGS.some((accepted) => sameWords(accepted, args))) return fail(`${where}.args`, '[] or ["-lncheck","final"]');
  const measuredCpuSeconds = positiveNumber(value['measuredCpuSeconds'], `${where}.measuredCpuSeconds`);
  const budgetCpuSeconds = positiveInteger(value['budgetCpuSeconds'], `${where}.budgetCpuSeconds`);
  const derivedBudgetCpuSeconds = Math.ceil(2 * measuredCpuSeconds) + startupCpuSeconds;
  if (budgetCpuSeconds !== derivedBudgetCpuSeconds) return fail(`${where}.budgetCpuSeconds`, `${derivedBudgetCpuSeconds}, twice measuredCpuSeconds rounded up plus startupCpuSeconds`);
  return {
    config: configNameOf(value['config'], `${where}.config`),
    role,
    expect: expectationOf(value['expect'], `${where}.expect`),
    args: args as string[],
    tier,
    distinctStates: positiveInteger(value['distinctStates'], `${where}.distinctStates`),
    measuredSeconds: positiveNumber(value['measuredSeconds'], `${where}.measuredSeconds`),
    measuredCpuSeconds,
    budgetCpuSeconds,
  };
};

export const readManifest = (file: string): Manifest => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) return fail('the document', 'an object');
  if (parsed['format'] !== MANIFEST_FORMAT) return fail('format', `"${MANIFEST_FORMAT}"`);
  const entries = parsed['entries'];
  if (!Array.isArray(entries)) return fail('entries', 'an array');
  if (entries.length === 0) return refuse('entries', 'must not be empty');
  const startupCpuSeconds = positiveNumber(parsed['startupCpuSeconds'], 'startupCpuSeconds');
  return {
    format: MANIFEST_FORMAT,
    unitSuiteSeconds: positiveNumber(parsed['unitSuiteSeconds'], 'unitSuiteSeconds'),
    startupCpuSeconds,
    entries: entries.map((entry, index) => entryOf(entry, index, startupCpuSeconds)),
  };
};

export const moduleOf = (config: string): string => config.split('.')[0] as string;

export const discoveryProblems = (specDir: string, manifest: Manifest): string[] => {
  const files = fs.readdirSync(specDir);
  const onDisk = files.filter((file) => file.endsWith('.cfg')).map((file) => file.slice(0, -'.cfg'.length));
  const modules = new Set(files.filter((file) => file.endsWith('.tla')).map((file) => file.slice(0, -'.tla'.length)));
  const listed = manifest.entries.map((entry) => entry.config);
  const problems: string[] = [];
  for (const config of new Set(listed.filter((name, index) => listed.indexOf(name) !== index))) problems.push(`${config} is listed more than once in the manifest`);
  for (const config of onDisk) if (!listed.includes(config)) problems.push(`${config}.cfg is on disk but not listed in the manifest`);
  for (const config of new Set(listed)) if (!onDisk.includes(config)) problems.push(`${config} is listed in the manifest but ${config}.cfg is not on disk`);
  for (const config of onDisk) if (!modules.has(moduleOf(config))) problems.push(`${config}.cfg names the module ${moduleOf(config)}, but ${moduleOf(config)}.tla is not on disk`);
  for (const module of modules) if (!onDisk.some((config) => moduleOf(config) === module)) problems.push(`${module}.tla has no configuration`);
  return problems;
};
