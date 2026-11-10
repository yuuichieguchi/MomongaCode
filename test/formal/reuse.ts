import { spawn } from '@momonga/testkit/child-process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from '@momonga/foundation';
import { moduleOf } from './manifest-reader.ts';
import type { ManifestEntry } from './manifest-reader.ts';
import { killGroup, trackGroup } from './runner.ts';
import type { TlcFacts } from './verdict.ts';

export const REUSE_ENV = 'MOMONGA_TLC_REUSE';

export const RAN_REASONS = [
  'deep tier',
  'reuse off',
  'JAVA_TOOL_OPTIONS is set',
  '_JAVA_OPTIONS is set',
  'JDK_JAVA_OPTIONS is set',
  'java not readable',
  'input not readable',
  'no record',
  'record unreadable',
  'record altered',
  'record does not satisfy the manifest entry',
] as const;

export type RanReason = (typeof RAN_REASONS)[number];

export const RECORDS_PER_CONFIG = 8;

type Env = Readonly<Record<string, string | undefined>>;

export const reuseModeOf = (env: Env): 'on' | 'off' => {
  const value = env[REUSE_ENV];
  if (value === undefined || value === '0') return 'off';
  if (value === '1') return 'on';
  throw new Error(`${REUSE_ENV} must be 1 or 0, got "${value}"`);
};

const JAVA_OPTION_VARIABLES = ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS'] as const;

export const refusalOf = (env: Env): RanReason | undefined => {
  const set = JAVA_OPTION_VARIABLES.find((name) => (env[name] ?? '').length > 0);
  return set === undefined ? undefined : `${set} is set`;
};

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const fields = value as Record<string, unknown>;
  return `{${Object.keys(fields)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${canonicalJson(fields[name])}`)
    .join(',')}}`;
};

export const sha256Hex = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

export type JavaIdentity = { readonly runtime: string; readonly vm: string; readonly os: string; readonly arch: string };

const JAVA_PROPERTIES = { runtime: 'java.runtime.version', vm: 'java.vm.name', os: 'os.name', arch: 'os.arch' } as const;

type JavaField = keyof typeof JAVA_PROPERTIES;

const JAVA_FIELDS = Object.keys(JAVA_PROPERTIES) as JavaField[];

const PROPERTY_SEPARATOR = ' = ';

type LineSink = { feed: (chunk: string) => void; end: () => void };

const createPropertyReader = (): { sink: () => LineSink; identity: () => JavaIdentity | undefined } => {
  const found = new Map<JavaField, string>();
  const takeLine = (line: string): void => {
    const text = line.trimStart();
    for (const field of JAVA_FIELDS) {
      const opening = `${JAVA_PROPERTIES[field]}${PROPERTY_SEPARATOR}`;
      if (!found.has(field) && text.startsWith(opening)) found.set(field, text.slice(opening.length).trim());
    }
  };
  return {
    sink: () => {
      let partial = '';
      return {
        feed: (chunk) => {
          const lines = `${partial}${chunk}`.split('\n');
          partial = lines.pop() as string;
          for (const line of lines) takeLine(line);
        },
        end: () => {
          takeLine(partial);
          partial = '';
        },
      };
    },
    identity: () => {
      const [runtime, vm, os, arch] = JAVA_FIELDS.map((field) => found.get(field) ?? '') as [string, string, string, string];
      return [runtime, vm, os, arch].every((value) => value.length > 0) ? { runtime, vm, os, arch } : undefined;
    },
  };
};

export type LimitTimer = { after(ms: number, fire: () => void): () => void };

const hostTimer: LimitTimer = {
  after: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    return () => clearTimeout(handle);
  },
};

const readJavaIdentity = (env: Env, timer: LimitTimer, limitMs: number): Promise<JavaIdentity | undefined> =>
  new Promise((resolve) => {
    const child = spawn('java', ['-XshowSettings:properties', '-version'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const pid = child.pid;
    if (pid === undefined) {
      child.once('error', () => resolve(undefined));
      return;
    }
    const untrackGroup = trackGroup(pid);
    let passedLimit = false;
    const cancelLimit = timer.after(limitMs, () => {
      passedLimit = true;
      killGroup(pid);
    });
    const properties = createPropertyReader();
    const sinks = [child.stdout, child.stderr].map((stream) => {
      const sink = properties.sink();
      stream.setEncoding('utf8');
      stream.on('data', sink.feed);
      return sink;
    });
    child.once('close', () => {
      cancelLimit();
      killGroup(pid);
      untrackGroup();
      for (const sink of sinks) sink.end();
      resolve(passedLimit ? undefined : properties.identity());
    });
  });

export const createJavaIdentityReader = (options: { env: Env; timer?: LimitTimer }): ((limitMs: number) => Promise<JavaIdentity | undefined>) => {
  let answer: Promise<JavaIdentity | undefined> | undefined;
  return (limitMs) => {
    answer ??= readJavaIdentity(options.env, options.timer ?? hostTimer, limitMs);
    return answer;
  };
};

export type KeyParts = {
  readonly format: typeof KEY_FORMAT;
  readonly config: string;
  readonly harness: Readonly<Record<string, string>>;
  readonly jar: string;
  readonly java: JavaIdentity;
  readonly workers: number;
  readonly args: readonly string[];
  readonly cfg: string;
  readonly modules: readonly (readonly [string, string])[];
};

const KEY_FORMAT = 'momonga-tlc-key/1';

const HARNESS_FILES = ['scripts/tlc.sh', 'test/formal/runner.ts', 'test/formal/verdict.ts', 'test/formal/manifest-reader.ts', 'test/formal/reuse.ts', 'test/formal/check-entry.ts', 'test/formal/tier.ts'] as const;

const JAR_FILE = '.cache/tla/tla2tools.jar';

const SPEC_DIR = 'specs/tla';

class UnreadableInput extends Error {
  readonly file: string;

  constructor(file: string, cause: unknown) {
    super(`${file} cannot be read`, { cause });
    this.file = file;
  }
}

const readable = async <T>(file: string, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    throw new UnreadableInput(file, error);
  }
};

const digestOfFile = (file: string): Promise<string> =>
  readable(file, async () => {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  });

const absoluteOf = (repoRoot: string, relative: string): string => path.join(repoRoot, ...relative.split('/'));

export const harnessDigests = async (repoRoot: string): Promise<Record<string, string>> =>
  Object.fromEntries(await Promise.all(HARNESS_FILES.map(async (file) => [file, await digestOfFile(absoluteOf(repoRoot, file))] as const)));

export const jarDigest = (repoRoot: string): Promise<string> => digestOfFile(absoluteOf(repoRoot, JAR_FILE));

const EXTENDS_WORD = /\bEXTENDS\b/g;
const INSTANCE_WORD = /\bINSTANCE\b/g;
const EXTENDS_FORM = /\bEXTENDS\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/g;
const INSTANCE_FORM = /\bINSTANCE\s+([A-Za-z_][A-Za-z0-9_]*)/g;

const countOf = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

const namedModulesOf = (text: string): { names: string[]; complete: boolean } => {
  const extended = [...text.matchAll(EXTENDS_FORM)];
  const instanced = [...text.matchAll(INSTANCE_FORM)];
  return {
    names: [...extended.flatMap((match) => (match[1] as string).split(',').map((name) => name.trim())), ...instanced.map((match) => match[1] as string)],
    complete: extended.length + instanced.length === countOf(text, EXTENDS_WORD) + countOf(text, INSTANCE_WORD),
  };
};

const moduleFile = (specDir: string, name: string): string => path.join(specDir, `${name}.tla`);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const localModuleBytes = async (specDir: string, name: string): Promise<Buffer | undefined> => {
  const file = moduleFile(specDir, name);
  try {
    return await fs.promises.readFile(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new UnreadableInput(file, error);
  }
};

type ModuleClosure = { readonly digests: ReadonlyMap<string, string>; readonly complete: boolean };

const readClosure = async (specDir: string, rootModule: string): Promise<ModuleClosure> => {
  const rootFile = moduleFile(specDir, rootModule);
  const digests = new Map<string, string>();
  const visited = new Set<string>([rootModule]);
  let complete = true;
  let pending: (readonly [string, Buffer])[] = [[rootModule, await readable(rootFile, () => fs.promises.readFile(rootFile))]];
  while (pending.length > 0) {
    const named: string[] = [];
    for (const [name, bytes] of pending) {
      digests.set(name, sha256Hex(bytes));
      const reading = namedModulesOf(bytes.toString('utf8'));
      complete &&= reading.complete;
      named.push(...reading.names);
    }
    const unvisited = [...new Set(named)].filter((name) => !visited.has(name));
    for (const name of unvisited) visited.add(name);
    const local = await Promise.all(unvisited.map(async (name) => [name, await localModuleBytes(specDir, name)] as const));
    pending = local.filter((module): module is readonly [string, Buffer] => module[1] !== undefined);
  }
  return { digests, complete };
};

export const closureOf = async (specDir: string, rootModule: string): Promise<{ modules: readonly string[]; complete: boolean }> => {
  const closure = await readClosure(specDir, rootModule);
  return { modules: [...closure.digests.keys()].sort(), complete: closure.complete };
};

const MODULE_SUFFIX = '.tla';

const everyModuleDigest = async (specDir: string): Promise<ReadonlyMap<string, string>> => {
  const names = (await readable(specDir, () => fs.promises.readdir(specDir))).filter((file) => file.endsWith(MODULE_SUFFIX)).map((file) => file.slice(0, -MODULE_SUFFIX.length));
  return new Map(await Promise.all(names.map(async (name) => [name, await digestOfFile(moduleFile(specDir, name))] as const)));
};

const moduleDigests = async (specDir: string, rootModule: string): Promise<(readonly [string, string])[]> => {
  const closure = await readClosure(specDir, rootModule);
  const digests = closure.complete ? closure.digests : await everyModuleDigest(specDir);
  return [...digests.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
};

export type KeyRequest = { readonly repoRoot: string; readonly entry: ManifestEntry; readonly args: readonly string[]; readonly workers: number; readonly java: JavaIdentity };

export const keyPartsOf = async ({ repoRoot, entry, args, workers, java }: KeyRequest): Promise<KeyParts | { unreadable: string }> => {
  const specDir = absoluteOf(repoRoot, SPEC_DIR);
  try {
    const [harness, jar, cfg, modules] = await Promise.all([
      harnessDigests(repoRoot),
      jarDigest(repoRoot),
      digestOfFile(path.join(specDir, `${entry.config}.cfg`)),
      moduleDigests(specDir, moduleOf(entry.config)),
    ]);
    return { format: KEY_FORMAT, config: entry.config, harness, jar, java, workers, args: [...args], cfg, modules };
  } catch (error) {
    if (error instanceof UnreadableInput) return { unreadable: path.relative(repoRoot, error.file).split(path.sep).join('/') };
    throw error;
  }
};

export const keyOf = (parts: KeyParts): string => sha256Hex(canonicalJson(parts));

const RECORD_FORMAT = 'momonga-tlc-result/1';

export type StoredFacts = TlcFacts & { readonly exitCode: 0 | 12 | 13; readonly signal: null };

export type ResultRecord = {
  readonly format: typeof RECORD_FORMAT;
  readonly key: string;
  readonly config: string;
  readonly facts: StoredFacts;
  readonly producedAt: string;
  readonly selfSha256: string;
};

export const sealedRecord = (body: Omit<ResultRecord, 'selfSha256'>): ResultRecord => ({ ...body, selfSha256: sha256Hex(canonicalJson(body)) });

export type StoreRead = { kind: 'hit'; record: ResultRecord } | { kind: 'miss'; reason: 'no record' | 'record unreadable' | 'record altered' };

export type StoreWrite = { stored: true } | { stored: false; reason: string };

export type StoreOps = {
  mkdir(dir: string): Promise<void>;
  writeExclusive(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(file: string, maxBytes: number): Promise<Buffer>;
  readdir(dir: string): Promise<readonly { name: string; isDirectory: boolean }[]>;
  mtimeMs(file: string): Promise<number>;
  unlink(file: string): Promise<void>;
  removeDirectory(dir: string): Promise<void>;
  isProcessAlive(pid: number): boolean;
  pid(): number;
  randomHex(bytes: number): string;
};

export type ResultStore = {
  read(config: string, key: string): Promise<StoreRead>;
  write(record: ResultRecord): Promise<StoreWrite>;
  removeOrphans(configs: readonly string[]): Promise<{ removed: number; reason?: string }>;
};

const hostStoreOps: StoreOps = {
  mkdir: async (dir) => {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  },
  writeExclusive: (file, text) => fs.promises.writeFile(file, text, { flag: 'wx', mode: 0o600 }),
  rename: (from, to) => fs.promises.rename(from, to),
  readFile: async (file, maxBytes) => {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      let filled = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, filled, maxBytes - filled, filled);
        filled += bytesRead;
        if (bytesRead === 0 || filled === maxBytes) return buffer.subarray(0, filled);
      }
    } finally {
      await handle.close();
    }
  },
  readdir: async (dir) => (await fs.promises.readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
  mtimeMs: async (file) => (await fs.promises.stat(file)).mtimeMs,
  unlink: (file) => fs.promises.unlink(file),
  removeDirectory: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
  isProcessAlive: (pid) => isProcessAlive(pid),
  pid: () => process.pid,
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
};

const RECORD_MAX_BYTES = 65536;
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
const TEMPORARY_FILE = /^\.[0-9a-f]{64}\.(\d+)\.[0-9a-f]{8}\.tmp$/;
const TEMPORARY_SUFFIX_BYTES = 4;
const STORED_EXIT_CODES: readonly unknown[] = [0, 12, 13];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isNames = (value: unknown): boolean => Array.isArray(value) && value.every((name) => typeof name === 'string');

const isStoredFacts = (value: unknown): boolean =>
  isRecord(value) &&
  STORED_EXIT_CODES.includes(value['exitCode']) &&
  value['signal'] === null &&
  typeof value['completed'] === 'boolean' &&
  (value['distinctStates'] === null || Number.isInteger(value['distinctStates'])) &&
  isNames(value['invariantsViolated']) &&
  isNames(value['actionPropertiesViolated']) &&
  typeof value['temporalViolated'] === 'boolean';

const isResultRecord = (value: unknown): value is ResultRecord =>
  isRecord(value) &&
  value['format'] === RECORD_FORMAT &&
  typeof value['key'] === 'string' &&
  typeof value['config'] === 'string' &&
  typeof value['producedAt'] === 'string' &&
  typeof value['selfSha256'] === 'string' &&
  isStoredFacts(value['facts']);

const parsedOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createResultStore = (dir: string, ops: StoreOps = hostStoreOps): ResultStore => {
  const configDir = (config: string): string => path.join(dir, config);
  const recordFile = (config: string, key: string): string => path.join(configDir(config), `${key}.json`);

  const read = async (config: string, key: string): Promise<StoreRead> => {
    let bytes: Buffer;
    try {
      bytes = await ops.readFile(recordFile(config, key), RECORD_MAX_BYTES + 1);
    } catch (error) {
      return { kind: 'miss', reason: isMissing(error) ? 'no record' : 'record unreadable' };
    }
    if (bytes.length > RECORD_MAX_BYTES) return { kind: 'miss', reason: 'record unreadable' };
    const record = parsedOrUndefined(bytes.toString('utf8'));
    if (!isResultRecord(record)) return { kind: 'miss', reason: 'record unreadable' };
    const { selfSha256, ...body } = record;
    if (record.key !== key || record.config !== config || selfSha256 !== sha256Hex(canonicalJson(body))) return { kind: 'miss', reason: 'record altered' };
    return { kind: 'hit', record };
  };

  const ignoringFailure = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch {
      return;
    }
  };

  const mtimeOrGone = async (file: string): Promise<number | undefined> => {
    try {
      return await ops.mtimeMs(file);
    } catch {
      return undefined;
    }
  };

  const prune = (config: string): Promise<void> =>
    ignoringFailure(async () => {
      const names = (await ops.readdir(configDir(config))).map((entry) => entry.name);
      const dated = await Promise.all(names.filter((name) => RECORD_FILE.test(name)).map(async (name) => ({ name, mtimeMs: await mtimeOrGone(path.join(configDir(config), name)) })));
      const newestFirst = dated
        .filter((record): record is { name: string; mtimeMs: number } => record.mtimeMs !== undefined)
        .sort((left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : 1));
      const deadWriters = names.filter((name) => {
        const writer = TEMPORARY_FILE.exec(name);
        return writer !== null && !ops.isProcessAlive(Number(writer[1]));
      });
      for (const name of [...newestFirst.slice(RECORDS_PER_CONFIG).map((record) => record.name), ...deadWriters]) await ignoringFailure(() => ops.unlink(path.join(configDir(config), name)));
    });

  const write = async (record: ResultRecord): Promise<StoreWrite> => {
    const file = recordFile(record.config, record.key);
    const temporary = path.join(configDir(record.config), `.${record.key}.${ops.pid()}.${ops.randomHex(TEMPORARY_SUFFIX_BYTES)}.tmp`);
    try {
      await ops.mkdir(configDir(record.config));
      await ops.writeExclusive(temporary, JSON.stringify(record));
      await ops.rename(temporary, file);
    } catch (error) {
      return { stored: false, reason: messageOf(error) };
    }
    await prune(record.config);
    return { stored: true };
  };

  const removeOrphans = async (configs: readonly string[]): Promise<{ removed: number; reason?: string }> => {
    let listed: readonly { name: string; isDirectory: boolean }[];
    try {
      listed = await ops.readdir(dir);
    } catch (error) {
      return isMissing(error) ? { removed: 0 } : { removed: 0, reason: messageOf(error) };
    }
    const orphans = listed.filter((entry) => entry.isDirectory && !configs.includes(entry.name));
    try {
      for (const orphan of orphans) await ops.removeDirectory(path.join(dir, orphan.name));
    } catch (error) {
      return { removed: 0, reason: messageOf(error) };
    }
    return { removed: orphans.length };
  };

  return { read, write, removeOrphans };
};
