import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TIME_BOUND, hasRow, scanProduct, scanSource } from './support/host-bounds-scan.ts';
import type { FoundConstant, HostBounds, PerFile } from './support/host-bounds-scan.ts';
import { ROOT, parseSource } from './support/source-scan.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS, itWithDocuments } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const REGISTRY = path.join(ROOT, 'specs/host-bounds/registry.json');

const CONSTANTS_DOCUMENT_VARIABLE = 'MOMONGA_CONSTANTS_DOCUMENT';

const TIME_KINDS: readonly string[] = ['O', 'P', 'C'];

const SIZE_KINDS: readonly string[] = ['stated'];

const LACKS: readonly string[] = ['kind', 'row'];

interface RuledConstant extends FoundConstant {
  readonly kind: string;
  readonly owner: string;
  readonly row: string;
}

interface OpenConstant extends FoundConstant {
  readonly lacks: readonly string[];
}

interface OpenWait {
  readonly count: number;
  readonly fixedBy: string;
}

interface Registry {
  readonly kinds: PerFile<string>;
  readonly constants: readonly RuledConstant[];
  readonly signalTimeouts: PerFile<readonly string[]>;
  readonly burnDown: {
    readonly constants: readonly OpenConstant[];
    readonly literalBounds: PerFile<number>;
    readonly clientsWithoutEveryBound: PerFile<number>;
    readonly synchronousChildWaits: PerFile<OpenWait>;
  };
}

class RegistryShapeError extends Error {
  constructor(where: string, expected: string) {
    super(`${REGISTRY}: ${where} is not ${expected}`);
    this.name = 'RegistryShapeError';
  }
}

const recordOf = (value: unknown, where: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RegistryShapeError(where, 'an object');
  return Object.fromEntries(Object.entries(value));
};

const listOf = (value: unknown, where: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new RegistryShapeError(where, 'a list');
  return value;
};

const textOf = (value: unknown, where: string): string => {
  if (typeof value !== 'string') throw new RegistryShapeError(where, 'a text');
  return value;
};

const countOf = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new RegistryShapeError(where, 'a count of at least one');
  return value;
};

const textsOf = (value: unknown, where: string): readonly string[] => listOf(value, where).map((item, index) => textOf(item, `${where}[${index}]`));

const tableOf = <T>(value: unknown, where: string, read: (item: unknown, where: string) => T): PerFile<T> =>
  Object.fromEntries(Object.entries(recordOf(value, where)).map(([key, item]) => [key, read(item, `${where}.${key}`)]));

const ruledOf = (value: unknown, where: string): RuledConstant => {
  const entry = recordOf(value, where);
  return {
    name: textOf(entry['name'], `${where}.name`),
    file: textOf(entry['file'], `${where}.file`),
    kind: textOf(entry['kind'], `${where}.kind`),
    owner: textOf(entry['owner'], `${where}.owner`),
    row: textOf(entry['row'], `${where}.row`),
  };
};

const openOf = (value: unknown, where: string): OpenConstant => {
  const entry = recordOf(value, where);
  return { name: textOf(entry['name'], `${where}.name`), file: textOf(entry['file'], `${where}.file`), lacks: textsOf(entry['lacks'], `${where}.lacks`) };
};

const openWaitOf = (value: unknown, where: string): OpenWait => {
  const entry = recordOf(value, where);
  return { count: countOf(entry['count'], `${where}.count`), fixedBy: textOf(entry['fixedBy'], `${where}.fixedBy`) };
};

const registryOf = (value: unknown): Registry => {
  const registry = recordOf(value, 'the registry');
  const burnDown = recordOf(registry['burnDown'], 'burnDown');
  return {
    kinds: tableOf(registry['kinds'], 'kinds', textOf),
    constants: listOf(registry['constants'], 'constants').map((item, index) => ruledOf(item, `constants[${index}]`)),
    signalTimeouts: tableOf(registry['signalTimeouts'], 'signalTimeouts', textsOf),
    burnDown: {
      constants: listOf(burnDown['constants'], 'burnDown.constants').map((item, index) => openOf(item, `burnDown.constants[${index}]`)),
      literalBounds: tableOf(burnDown['literalBounds'], 'burnDown.literalBounds', countOf),
      clientsWithoutEveryBound: tableOf(burnDown['clientsWithoutEveryBound'], 'burnDown.clientsWithoutEveryBound', countOf),
      synchronousChildWaits: tableOf(burnDown['synchronousChildWaits'], 'burnDown.synchronousChildWaits', openWaitOf),
    },
  };
};

const readRegistry = (): Registry => {
  const parsed: unknown = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return registryOf(parsed);
};

const keyOf = (constant: FoundConstant): string => `${constant.file}#${constant.name}`;

const scanned = (text: string): HostBounds => scanSource(parseSource(path.join(ROOT, 'sample.ts'), text));

const namesIn = (text: string): string[] => scanned(text).constants.map((constant) => constant.name);

const kindsFor = (name: string): readonly string[] => (TIME_BOUND.test(name) ? TIME_KINDS : SIZE_KINDS);

describe('the scan of host bounds', () => {
  it('finds a named bound whatever its value is built from, and a numeric bound by its unit', () => {
    expect(namesIn('const WAIT_MS = 5;\nexport const READ_MAX_BYTES = limitOf(host);\nconst TITLE_CHARS = 80;\nconst STALE_SECONDS = 60;')).toEqual(['READ_MAX_BYTES', 'STALE_SECONDS', 'TITLE_CHARS', 'WAIT_MS']);
    expect(namesIn('const graceMs = 2 * 1000;\nconst derivedMs = WAIT_MS + 5;\nconst remainingMs = deadline - now;\nconst chosenMs = options.graceMs;')).toEqual(['derivedMs', 'graceMs']);
    expect(namesIn('const run = (): void => {\n  const INNER_MS = 5;\n};')).toEqual(['INNER_MS']);
  });

  it('counts a number literal that reaches a timer, a signal or a timeout property, and never a zero', () => {
    expect(scanned('timing.setTimeout(done, 5000);\nsetInterval(tick, 5 * 1000);\nawait sleep(timing, 250, signal);').literalBounds).toEqual({ 'sample.ts': 3 });
    expect(scanned('const signal = AbortSignal.timeout(3000);').literalBounds).toEqual({ 'sample.ts': 1 });
    expect(scanned('const options = { timeout: 100, headersTimeout: 5000, graceMs: 20, connectTimeoutMs: 1 };').literalBounds).toEqual({ 'sample.ts': 4 });
    expect(scanned('timing.setTimeout(done, WAIT_MS);\nsetTimeout(done, 0);\nconst options = { bodyTimeout: 0, timeoutMs: WAIT_MS, attempts: 3 };').literalBounds).toEqual({});
  });

  it('takes a name made only of a count and a unit of time for a unit, never for a bound', () => {
    expect(namesIn('const DAY_MS = 86_400_000;\nconst FIVE_MINUTES_MS = 5 * 60 * 1000;\nconst SECONDS_MS = 1000;\nconst SEVEN_DAYS_MS = 7 * DAY_MS;\nconst IDLE_MINUTES_MS = 5;\nconst MAX_DAY_MS = 9;')).toEqual(['IDLE_MINUTES_MS', 'MAX_DAY_MS']);
  });

  it('counts a synchronous child process call that sets no timeout, under any name it is reached by', () => {
    const text = [
      "import { spawnSync, execFileSync as run } from 'node:child_process';",
      "import childProcess from 'node:child_process';",
      "spawnSync('a', [], { stdio: 'ignore' });",
      "run('b');",
      "childProcess.execSync('c');",
      "childProcess.execSync('d', { timeout: LIMIT_MS });",
      "spawnSync('e', [], { timeout: 5, stdio: 'ignore' });",
    ].join('\n');
    expect(scanned(text).synchronousChildWaits).toEqual({ 'sample.ts': 3 });
  });

  it('names what each signal timeout is built from', () => {
    expect(scanned('const a = AbortSignal.timeout(START_MS);\nconst b = AbortSignal.any([given, AbortSignal.timeout(options.limitMs)]);').signalTimeouts).toEqual({ 'sample.ts': ['START_MS', 'options.limitMs'] });
  });

  it('counts a client construction that leaves a bound to a default, under any name the client is imported by', () => {
    expect(scanned("import { Agent as Dispatching } from 'undici';\nconst agent = new Dispatching({ connect });").clientsWithoutEveryBound).toEqual({ 'sample.ts': 1 });
    expect(scanned("import { Agent } from 'undici';\nconst agent = new Agent({ connect, headersTimeout: 0, bodyTimeout: 0 });").clientsWithoutEveryBound).toEqual({});
    expect(scanned("import { Agent } from 'undici';\nconst agent = new Agent({ connect, ...timeouts });").clientsWithoutEveryBound).toEqual({ 'sample.ts': 1 });
    expect(scanned("import { buildConnector } from 'undici';\nconst connect = buildConnector({ socketPath });").clientsWithoutEveryBound).toEqual({ 'sample.ts': 1 });
    expect(scanned('const a = createUdsClient(resolve);\nconst b = createUdsClient(resolve, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });').clientsWithoutEveryBound).toEqual({ 'sample.ts': 1 });
    expect(scanned("import { request } from 'undici';\nawait fetch(url);\nawait request(url, { dispatcher });").clientsWithoutEveryBound).toEqual({ 'sample.ts': 1 });
    expect(scanned("import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nconst client = new Client(info);").clientsWithoutEveryBound).toEqual({});
  });
});

describe('every host bound is registered once', () => {
  const registry = readRegistry();
  const found = scanProduct();

  it('registers every bound constant of the product, each in one list, and none that is gone', () => {
    const ruled = registry.constants.map(keyOf);
    const open = registry.burnDown.constants.map(keyOf);
    expect([...ruled, ...open].sort()).toEqual(found.constants.map(keyOf).sort());
  });

  it('keeps each list in the order of the scan, one entry per constant', () => {
    expect(registry.constants.map(keyOf)).toEqual(registry.constants.map(keyOf).sort());
    expect(registry.burnDown.constants.map(keyOf)).toEqual(registry.burnDown.constants.map(keyOf).sort());
  });

  it('rules a registered constant in full: a kind its unit admits, an owner and a row', () => {
    const unruled = registry.constants.filter((entry) => !kindsFor(entry.name).includes(entry.kind) || !(entry.kind in registry.kinds) || entry.owner.trim() === '' || !entry.row.endsWith('.md'));
    expect(unruled).toEqual([]);
  });

  it('says of every constant on the burn-down list what it lacks', () => {
    const vague = registry.burnDown.constants.filter((entry) => entry.lacks.length === 0 || entry.lacks.some((lack) => !LACKS.includes(lack)) || (entry.lacks.includes('kind') && !TIME_BOUND.test(entry.name)));
    expect(vague).toEqual([]);
  });

  it('registers what every signal timeout is built from', () => {
    expect(found.signalTimeouts).toEqual(registry.signalTimeouts);
  });

  it('lists exactly the number literals that still reach a timer, a signal or a timeout property', () => {
    expect(found.literalBounds).toEqual(registry.burnDown.literalBounds);
  });

  it('lists exactly the client constructions that still leave a bound to a default', () => {
    expect(found.clientsWithoutEveryBound).toEqual(registry.burnDown.clientsWithoutEveryBound);
  });

  it('lists exactly the synchronous child process calls that still wait with no bound, each with the item that fixes it', () => {
    expect(found.synchronousChildWaits).toEqual(Object.fromEntries(Object.entries(registry.burnDown.synchronousChildWaits).map(([file, wait]) => [file, wait.count])));
    expect(Object.values(registry.burnDown.synchronousChildWaits).filter((wait) => wait.fixedBy.trim() === '')).toEqual([]);
  });

  const rowsTitle = `finds the row of every ruled constant in the constants document named by ${CONSTANTS_DOCUMENT_VARIABLE}`;

  const staleTitle = `keeps on the burn-down list no constant said to lack a row that has one in the constants document named by ${CONSTANTS_DOCUMENT_VARIABLE}`;

  itWithDocuments(CONSTANTS_DOCUMENT_VARIABLE, import.meta.dirname, rowsTitle, (constantsDocument) => {
    expect(registry.constants.filter((entry) => !hasRow(fs.readFileSync(path.join(constantsDocument, entry.row), 'utf8'), entry.name))).toEqual([]);
  });
  itWithDocuments(CONSTANTS_DOCUMENT_VARIABLE, import.meta.dirname, staleTitle, (constantsDocument) => {
    const documents = fs
      .readdirSync(constantsDocument)
      .filter((file) => file.endsWith('.md'))
      .map((file) => fs.readFileSync(path.join(constantsDocument, file), 'utf8'));
    const rowed = (name: string): boolean => documents.some((document) => hasRow(document, name));
    expect(registry.burnDown.constants.filter((entry) => entry.lacks.includes('row') === rowed(entry.name)).map(keyOf)).toEqual([]);
  });
});
