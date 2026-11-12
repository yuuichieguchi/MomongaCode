import { spawn } from '@momonga/testkit/child-process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { groupAlive } from '@momonga/foundation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { cfgFor, holdsEntry, tinySpec, writeFile } from './fixtures.ts';
import type { ManifestEntry } from './manifest.ts';
import { HARNESS_FILES, canonicalJson, closureOf, createJavaIdentityReader, createResultStore, keyOf, keyPartsOf, refusalOf, reuseModeOf, sha256Hex } from './reuse.ts';
import type { JavaIdentity, KeyParts, ResultRecord, StoreOps } from './reuse.ts';
import { pollUntil } from '@momonga/testkit';


const JAVA: JavaIdentity = { runtime: '22.0.1+8-16', vm: 'OpenJDK 64-Bit Server VM', os: 'Mac OS X', arch: 'aarch64' };

const digestOf = (seed: string): string => sha256Hex(seed);

const flipFirstHex = (digest: string): string => `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;

const baseParts = (): KeyParts => ({
  format: 'momonga-tlc-key/2',
  config: 'Tiny',
  harness: Object.fromEntries(HARNESS_FILES.map((file) => [file, digestOf(file)])),
  jar: digestOf('jar'),
  java: { ...JAVA },
  workers: 5,
  args: ['-fp', '0'],
  cfg: digestOf('cfg'),
  modules: [['Tiny', digestOf('Tiny.tla')]],
  inputs: [['Handover.actors.json', digestOf('Handover.actors.json')]],
}) as unknown as KeyParts;

const withField = (change: (parts: Record<string, unknown>) => void): KeyParts => {
  const parts = structuredClone(baseParts()) as unknown as Record<string, unknown>;
  change(parts);
  return parts as unknown as KeyParts;
};

const recordOf = (config: string, key: string, distinctStates: number | null, producedAt = '2026-11-10T01:00:00.000Z'): ResultRecord => {
  const body = {
    format: 'momonga-tlc-result/1',
    key,
    config,
    facts: { exitCode: 0, signal: null, completed: true, distinctStates, invariantsViolated: [], actionPropertiesViolated: [], temporalViolated: false },
    producedAt,
  };
  return { ...body, selfSha256: sha256Hex(canonicalJson(body)) } as unknown as ResultRecord;
};

const stubJava = (bin: string, lines: readonly string[]): void => {
  writeFile(path.join(bin, 'java'), ['#!/bin/sh', ...lines, ''].join('\n'));
  fs.chmodSync(path.join(bin, 'java'), 0o755);
};

const settingsLines = (properties: readonly (readonly [string, string])[]): string[] => [
  'echo "Property settings:" >&2',
  ...properties.map(([name, value]) => `echo "    ${name} = ${value}" >&2`),
];

const FOUR_PROPERTIES: readonly (readonly [string, string])[] = [
  ['java.runtime.version', JAVA.runtime],
  ['java.vm.name', JAVA.vm],
  ['os.name', JAVA.os],
  ['os.arch', JAVA.arch],
];

const READER_LIMIT_MS = 30000;

const waitForFile = (file: string): Promise<void> => pollUntil(() => fs.existsSync(file), { description: `the file ${file}`, boundMs: READER_LIMIT_MS });

const linesOf = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0) : []);

describe('canonical JSON and the digest', () => {
  it('sorts object keys at every depth, keeps array order and writes no whitespace', () => {
    const text = canonicalJson({ z: { k: null, j: true }, a: [1, 'b'] });
    expect(text).toBe('{"a":[1,"b"],"z":{"j":true,"k":null}}');
    expect(sha256Hex(text)).toBe('61cf90264571b6d31ccc204126df7d639a6591db627872d548c91fc7ad4b00f7');
  });

  it('writes the lowercase hex sha256 of a text', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('the key of a run', () => {
  it('is the same lowercase hex digest every time for the same parts', () => {
    const first = keyOf(baseParts());
    expect(keyOf(baseParts())).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with every field of the parts, each change giving its own key', () => {
    const variants: KeyParts[] = [
      withField((parts) => {
        parts['config'] = 'Tiny.broken';
      }),
      ...HARNESS_FILES.map((file) =>
        withField((parts) => {
          const harness = parts['harness'] as Record<string, string>;
          harness[file] = flipFirstHex(harness[file] as string);
        }),
      ),
      withField((parts) => {
        parts['jar'] = flipFirstHex(parts['jar'] as string);
      }),
      ...(['runtime', 'vm', 'os', 'arch'] as const).map((field) =>
        withField((parts) => {
          const java = parts['java'] as Record<string, string>;
          java[field] = `${java[field]}x`;
        }),
      ),
      withField((parts) => {
        parts['workers'] = 4;
      }),
      withField((parts) => {
        parts['args'] = ['-lncheck', 'final', '-fp', '0'];
      }),
      withField((parts) => {
        parts['cfg'] = flipFirstHex(parts['cfg'] as string);
      }),
      withField((parts) => {
        parts['modules'] = [['Tiny', flipFirstHex(digestOf('Tiny.tla'))]];
      }),
      withField((parts) => {
        parts['inputs'] = [['Handover.actors.json', flipFirstHex(digestOf('Handover.actors.json'))]];
      }),
    ];
    expect(variants).toHaveLength(HARNESS_FILES.length + 11);
    const keys = new Set([keyOf(baseParts()), ...variants.map((parts) => keyOf(parts))]);
    expect(keys.size).toBe(HARNESS_FILES.length + 12);
  });
});

describe('the parts of a key read from a repository', () => {
  let root = '';

  const specFile = (name: string): string => path.join(root, 'specs', 'tla', name);

  beforeEach(() => {
    root = createTempRoot();
    for (const file of HARNESS_FILES) writeFile(path.join(root, file), `harness ${file}\n`);
    writeFile(path.join(root, 'test', 'formal', 'manifest.ts'), 'export const EVERY_RUN_BUDGET_RATIO = 23;\n');
    writeFile(path.join(root, '.cache', 'tla', 'tla2tools.jar'), 'fake jar bytes');
    writeFile(specFile('Tiny.tla'), tinySpec);
    writeFile(specFile('Tiny.cfg'), cfgFor('Small'));
    writeFile(specFile('Tiny.broken.cfg'), cfgFor('Small'));
    writeFile(specFile('Unrelated.tla'), '---- MODULE Unrelated ----\nEXTENDS Naturals\n====\n');
    writeFile(specFile('Handover.actors.json'), '[]\n');
    writeFile(specFile('manifest.json'), '{}\n');
  });

  afterEach(() => {
    if (fs.existsSync(specFile('Other.tla'))) fs.chmodSync(specFile('Other.tla'), 0o644);
    removeTempRoot(root);
  });

  const partsFor = (entry: ManifestEntry = holdsEntry) => keyPartsOf({ repoRoot: root, entry, args: [...entry.args, '-fp', '0'], workers: 5, java: JAVA });

  const keyFor = async (entry: ManifestEntry = holdsEntry): Promise<string> => {
    const parts = await partsFor(entry);
    if ('unreadable' in parts) throw new Error(`unreadable ${parts.unreadable}`);
    return keyOf(parts);
  };

  const sameKeyCases: readonly (readonly [string, () => ManifestEntry])[] = [
    ['measuredSeconds', () => ({ ...holdsEntry, measuredSeconds: 99 })],
    ['measuredCpuSeconds', () => ({ ...holdsEntry, measuredCpuSeconds: 99 })],
    ['budgetCpuSeconds', () => ({ ...holdsEntry, budgetCpuSeconds: 201 })],
    ['distinctStates', () => ({ ...holdsEntry, distinctStates: 4 })],
    ['expect', () => ({ ...holdsEntry, expect: { violates: 'Small', exitCode: 12 } })],
    ['role', () => ({ ...holdsEntry, role: 'evidence' })],
    ['tier', () => ({ ...holdsEntry, tier: 'deep' })],
  ];

  it.each(sameKeyCases)('gives the same parts when the row field %s changes', async (_field, changed) => {
    expect(await partsFor(changed())).toEqual(await partsFor());
  });

  it.each([
    ['the text of test/formal/manifest.ts', 'test/formal/manifest.ts'],
    ['a module outside the closure', 'specs/tla/Unrelated.tla'],
    ['the configuration file of another configuration', 'specs/tla/Tiny.broken.cfg'],
  ])('gives the same parts when %s changes', async (_label, file) => {
    const before = await partsFor();
    fs.appendFileSync(path.join(root, file), ' ');
    expect(await partsFor()).toEqual(before);
  });

  it('gives another key when a JSON input of the specs changes, such as specs/tla/Handover.actors.json', async () => {
    const before = await keyFor();
    fs.appendFileSync(specFile('Handover.actors.json'), ' ');
    expect(await keyFor()).not.toBe(before);
  });

  it('gives another key when a JSON input is added to specs/tla', async () => {
    const before = await keyFor();
    writeFile(specFile('Retention.stores.json'), '[]\n');
    expect(await keyFor()).not.toBe(before);
  });

  it('gives the same parts when only the measurements of the manifest change', async () => {
    const before = await partsFor();
    fs.appendFileSync(specFile('manifest.json'), ' ');
    expect(await partsFor()).toEqual(before);
  });

  it('gives another key when the one reader of a configuration changes', async () => {
    const before = await keyFor();
    fs.appendFileSync(path.join(root, 'test', 'formal', 'cfg-names.ts'), ' ');
    expect(await keyFor()).not.toBe(before);
  });

  it('gives another key when one byte of the manifest reader changes', async () => {
    const before = await keyFor();
    fs.appendFileSync(path.join(root, 'test', 'formal', 'manifest-reader.ts'), ' ');
    expect(await keyFor()).not.toBe(before);
  });

  it('holds the stated fields with repository-relative harness paths and the closure modules', async () => {
    const parts = (await partsFor()) as KeyParts;
    expect(Object.keys(parts.harness).sort()).toEqual([...HARNESS_FILES].sort());
    expect(Object.keys(parts.harness)).toContain('test/formal/cfg-names.ts');
    expect(parts.modules).toEqual([['Tiny', sha256Hex(tinySpec)]]);
    expect(parts.cfg).toBe(sha256Hex(cfgFor('Small')));
    expect(parts.jar).toBe(sha256Hex('fake jar bytes'));
    expect(parts.args).toEqual(['-fp', '0']);
    expect(parts.workers).toBe(5);
    expect(parts.java).toEqual(JAVA);
    expect(parts.config).toBe('Tiny');
    expect(parts.inputs).toEqual([['Handover.actors.json', sha256Hex('[]\n')]]);
    expect(parts.format).toBe('momonga-tlc-key/2');
  });

  it.each([
    ['the jar', '.cache/tla/tla2tools.jar'],
    ['the configuration file', 'specs/tla/Tiny.cfg'],
    ['the root module', 'specs/tla/Tiny.tla'],
    ['a harness file', 'test/formal/runner.ts'],
  ])('reports %s as unreadable when it is missing, without throwing', async (_label, file) => {
    fs.rmSync(path.join(root, file));
    expect(await partsFor()).toEqual({ unreadable: file });
  });

  it.skipIf(process.getuid?.() === 0)('reports a module of the closure that exists but cannot be read as unreadable, without throwing', async () => {
    writeFile(specFile('Tiny.tla'), tinySpec.replace('EXTENDS Naturals', 'EXTENDS Naturals, Other'));
    writeFile(specFile('Other.tla'), '---- MODULE Other ----\n====\n');
    fs.chmodSync(specFile('Other.tla'), 0o000);
    expect(await partsFor()).toEqual({ unreadable: 'specs/tla/Other.tla' });
  });

  it('changes the key when the last module of an EXTENDS chain changes', async () => {
    writeFile(specFile('Tiny.tla'), tinySpec.replace('EXTENDS Naturals', 'EXTENDS Naturals, Middle'));
    writeFile(specFile('Middle.tla'), '---- MODULE Middle ----\nEXTENDS Last\n====\n');
    writeFile(specFile('Last.tla'), '---- MODULE Last ----\nEXTENDS Naturals\n====\n');
    const before = await keyFor();
    fs.appendFileSync(specFile('Last.tla'), ' ');
    expect(await keyFor()).not.toBe(before);
  });

  it('keys on every module of the directory when the root cannot be read completely', async () => {
    writeFile(specFile('Tiny.tla'), `${tinySpec}\n\\* EXTENDS (see below)\n`);
    const parts = (await partsFor()) as KeyParts;
    expect(parts.modules.map(([name]) => name)).toEqual(['Tiny', 'Unrelated']);
    const before = keyOf(parts);
    fs.appendFileSync(specFile('Unrelated.tla'), ' ');
    expect(await keyFor()).not.toBe(before);
  });

  const helperModule = '---- MODULE Helper ----\nEXTENDS Naturals\n====\n';

  const cutOffShapes: readonly (readonly [string, string])[] = [
    ['an EXTENDS list continued on the next line after a line comment', 'EXTENDS Naturals, Sequences, \\* standard\n        Helper'],
    ['an EXTENDS list with a block comment before a name', 'EXTENDS Naturals, (* c *) Helper'],
    ['an EXTENDS list with a block comment before a comma', 'EXTENDS Naturals (* c *), Helper'],
    ['an INSTANCE whose module name stands on the next line after a line comment', 'EXTENDS Naturals\nINSTANCE \\* the helper\n        Helper'],
    ['an INSTANCE with a block comment before its module name', 'EXTENDS Naturals\nINSTANCE (* c *) Helper'],
  ];

  it.each(cutOffShapes)('keys on every module of the directory and sees a change of the module named after the comment in %s', async (_label, opening) => {
    writeFile(specFile('Tiny.tla'), tinySpec.replace('EXTENDS Naturals', opening));
    writeFile(specFile('Helper.tla'), helperModule);
    const parts = (await partsFor()) as KeyParts;
    expect(parts.modules.map(([name]) => name)).toEqual(['Helper', 'Tiny', 'Unrelated']);
    const before = keyOf(parts);
    fs.appendFileSync(specFile('Helper.tla'), ' ');
    expect(await keyFor()).not.toBe(before);
  });

  it.each([
    ['an INSTANCE followed by a line comment', 'EXTENDS Naturals\nINSTANCE Helper \\* the helper'],
    ['an INSTANCE with a block comment before WITH', 'EXTENDS Naturals\nH == INSTANCE Helper (* c *) WITH a <- x'],
  ])('keys on every module of the directory for %s', async (_label, opening) => {
    writeFile(specFile('Tiny.tla'), tinySpec.replace('EXTENDS Naturals', opening));
    writeFile(specFile('Helper.tla'), helperModule);
    const parts = (await partsFor()) as KeyParts;
    expect(parts.modules.map(([name]) => name)).toEqual(['Helper', 'Tiny', 'Unrelated']);
  });
});

describe('the closure of a root module', () => {
  let specDir = '';

  beforeEach(() => {
    specDir = createTempRoot();
  });

  afterEach(() => {
    removeTempRoot(specDir);
  });

  const moduleText = (name: string, body: string): string => `---- MODULE ${name} ----\n${body}\n====\n`;

  it.each([
    ['EXTENDS of a standard and a local module', { Root: 'EXTENDS Naturals, Other', Other: '' }, 'Root', ['Other', 'Root']],
    ['an EXTENDS list across two lines', { Root: 'EXTENDS Naturals,\n        Other', Other: '' }, 'Root', ['Other', 'Root']],
    ['INSTANCE', { Root: 'INSTANCE Other', Other: '' }, 'Root', ['Other', 'Root']],
    ['LOCAL INSTANCE', { Root: 'LOCAL INSTANCE Other', Other: '' }, 'Root', ['Other', 'Root']],
    ['a named INSTANCE WITH a substitution', { Root: 'X == INSTANCE Other WITH a <- b', Other: '' }, 'Root', ['Other', 'Root']],
    ['a chain of EXTENDS', { A: 'EXTENDS B', B: 'EXTENDS C', C: '' }, 'A', ['A', 'B', 'C']],
    ['a cycle', { A: 'EXTENDS B', B: 'EXTENDS A' }, 'A', ['A', 'B']],
    ['a local module named like a standard module', { Root: 'EXTENDS Naturals', Naturals: '' }, 'Root', ['Naturals', 'Root']],
    ['a standard module alone', { Root: 'EXTENDS Naturals' }, 'Root', ['Root']],
  ] as const)('follows %s', async (_label, modules, root, expected) => {
    for (const [name, body] of Object.entries(modules)) writeFile(path.join(specDir, `${name}.tla`), moduleText(name, body));
    expect(await closureOf(specDir, root)).toEqual({ modules: expected, complete: true });
  });

  it.each([
    ['an EXTENDS list continued on the next line after a line comment', 'EXTENDS Naturals, Sequences, \\* standard\n        Helper'],
    ['an EXTENDS list with a block comment before a name', 'EXTENDS Naturals, (* c *) Helper'],
    ['an EXTENDS list with a block comment before a comma', 'EXTENDS Naturals (* c *), Helper'],
    ['an EXTENDS list followed by a line comment', 'EXTENDS Naturals, Helper \\* standard'],
    ['an INSTANCE whose module name stands on the next line after a line comment', 'INSTANCE \\* the helper\n        Helper'],
    ['an INSTANCE with a block comment before its module name', 'INSTANCE (* c *) Helper'],
    ['an INSTANCE followed by a line comment', 'INSTANCE Helper \\* the helper'],
    ['an INSTANCE with a block comment before WITH', 'H == INSTANCE Helper (* c *) WITH a <- x'],
  ])('is incomplete for %s', async (_label, body) => {
    writeFile(path.join(specDir, 'Root.tla'), moduleText('Root', body));
    writeFile(path.join(specDir, 'Helper.tla'), moduleText('Helper', ''));
    expect((await closureOf(specDir, 'Root')).complete).toBe(false);
  });

  it('is incomplete when the word EXTENDS stands without a module name after it', async () => {
    writeFile(path.join(specDir, 'Root.tla'), moduleText('Root', 'EXTENDS Naturals\n\\* EXTENDS (see below)'));
    expect((await closureOf(specDir, 'Root')).complete).toBe(false);
  });
});

describe('the reuse mode and the refusals', () => {
  it.each([
    [undefined, 'off'],
    ['0', 'off'],
    ['1', 'on'],
  ])('reads MOMONGA_TLC_REUSE=%s as %s', (value, mode) => {
    expect(reuseModeOf({ MOMONGA_TLC_REUSE: value })).toBe(mode);
  });

  it.each(['yes', ''])('refuses MOMONGA_TLC_REUSE=%j', (value) => {
    expect(() => reuseModeOf({ MOMONGA_TLC_REUSE: value })).toThrow(`MOMONGA_TLC_REUSE must be 1 or 0, got "${value}"`);
  });

  it.each(['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS'])('refuses a run with %s set', (name) => {
    expect(refusalOf({ [name]: '-Dx=1' })).toBe(`${name} is set`);
  });

  it.each(['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS'])('does not refuse a run with %s empty', (name) => {
    expect(refusalOf({ [name]: '' })).toBeUndefined();
  });

  it('does not refuse a run with none of the Java variables', () => {
    expect(refusalOf({})).toBeUndefined();
  });

  it('names JAVA_TOOL_OPTIONS first when it and _JAVA_OPTIONS are both set', () => {
    expect(refusalOf({ _JAVA_OPTIONS: '-Dx=1', JAVA_TOOL_OPTIONS: '-Dx=1' })).toBe('JAVA_TOOL_OPTIONS is set');
  });
});

describe('the Java identity reader', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
  });

  afterEach(() => {
    removeTempRoot(root);
  });

  const binWith = (lines: readonly string[] | undefined): string => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (lines !== undefined) stubJava(bin, lines);
    return lines === undefined ? bin : `${bin}:/usr/bin:/bin`;
  };

  const readerWith = (lines: readonly string[] | undefined) => createJavaIdentityReader({ env: { ...process.env, PATH: binWith(lines) } });

  it('reads the four properties a java prints', async () => {
    expect(await readerWith([...settingsLines(FOUR_PROPERTIES), 'exit 0'])(READER_LIMIT_MS)).toEqual(JAVA);
  });

  it('gives no identity when java.runtime.version is missing', async () => {
    expect(await readerWith([...settingsLines(FOUR_PROPERTIES.slice(1)), 'exit 0'])(READER_LIMIT_MS)).toBeUndefined();
  });

  it('takes the first of two os.name lines', async () => {
    expect(await readerWith([...settingsLines([...FOUR_PROPERTIES, ['os.name', 'Linux']]), 'exit 0'])(READER_LIMIT_MS)).toEqual(JAVA);
  });

  it('reads the identity after 30 000 other property lines', async () => {
    const lines = [
      'echo "Property settings:" >&2',
      'i=0',
      'while [ "$i" -lt 30000 ]; do echo "    other.property.$i = 0123456789012345678901234567890123456789" >&2; i=$((i + 1)); done',
      ...settingsLines(FOUR_PROPERTIES).slice(1),
      'exit 0',
    ];
    expect(await readerWith(lines)(READER_LIMIT_MS)).toEqual(JAVA);
  });

  it('gives no identity when PATH has no java', async () => {
    expect(await readerWith(undefined)(READER_LIMIT_MS)).toBeUndefined();
  });

  it('starts java once and answers every call with the one result', async () => {
    const counter = path.join(root, 'starts');
    const read = readerWith([`echo start >> "${counter}"`, ...settingsLines(FOUR_PROPERTIES), 'exit 0']);
    const results = [await read(READER_LIMIT_MS), await read(READER_LIMIT_MS), await read(READER_LIMIT_MS)];
    expect(results).toEqual([JAVA, JAVA, JAVA]);
    expect(linesOf(counter)).toEqual(['start']);
  });

  it('kills a java that never exits when its limit fires, leaves no group and remembers that there is no identity', async () => {
    const counter = path.join(root, 'starts');
    const pidFile = path.join(root, 'pid');
    const armed: { ms: number; fire: () => void }[] = [];
    const timer = {
      after: (ms: number, fire: () => void): (() => void) => {
        armed.push({ ms, fire });
        return () => undefined;
      },
    };
    const env = { ...process.env, PATH: binWith([`echo start >> "${counter}"`, `echo $$ > "${pidFile}.tmp"`, `mv "${pidFile}.tmp" "${pidFile}"`, 'exec sleep 1000']) };
    const read = createJavaIdentityReader({ env, timer });
    const first = read(300);
    await waitForFile(pidFile);
    expect(armed.map(({ ms }) => ms)).toEqual([300]);
    (armed[0] as { fire: () => void }).fire();
    expect(await first).toBeUndefined();
    const pgid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await pollUntil(async () => !(await groupAlive(pgid)), { description: `the end of the process group ${pgid}`, boundMs: READER_LIMIT_MS });
    expect(await read(300)).toBeUndefined();
    expect(linesOf(counter)).toEqual(['start']);
  });
});

describe('the result store', () => {
  let dir = '';

  beforeEach(() => {
    dir = createTempRoot();
  });

  afterEach(() => {
    removeTempRoot(dir);
  });

  const keyNamed = (seed: string): string => sha256Hex(seed);

  const recordPath = (config: string, key: string): string => path.join(dir, config, `${key}.json`);

  const placeFile = (config: string, key: string, content: string | Buffer): void => {
    fs.mkdirSync(path.join(dir, config), { recursive: true });
    fs.writeFileSync(recordPath(config, key), content);
  };

  const sealed = (body: Record<string, unknown>): string => JSON.stringify({ ...body, selfSha256: sha256Hex(canonicalJson(body)) });

  it('reads back the record it wrote, and the later record after a second write of the same key', async () => {
    const store = createResultStore(dir);
    const key = keyNamed('one');
    const first = recordOf('Tiny', key, 3);
    expect(await store.write(first)).toEqual({ stored: true });
    expect(await store.read('Tiny', key)).toEqual({ kind: 'hit', record: first });
    const second = recordOf('Tiny', key, 4);
    expect(await store.write(second)).toEqual({ stored: true });
    expect(await store.read('Tiny', key)).toEqual({ kind: 'hit', record: second });
  });

  const keyA = sha256Hex('key-a');
  const keyB = sha256Hex('key-b');
  const validText = JSON.stringify(recordOf('Tiny', keyA, 3));
  const { selfSha256: _sealOfA, ...bodyOfA } = recordOf('Tiny', keyA, 3) as unknown as Record<string, unknown>;

  const damagedFiles: readonly (readonly [string, string | undefined, string])[] = [
    ['no file', undefined, 'no record'],
    ['invalid JSON', '{ not json', 'record unreadable'],
    ['a valid record cut at half its length', validText.slice(0, Math.floor(validText.length / 2)), 'record unreadable'],
    ['one digit of facts.distinctStates changed', validText.replace('"distinctStates":3', '"distinctStates":4'), 'record altered'],
    ['a valid record of another key under this file name', JSON.stringify(recordOf('Tiny', keyB, 3)), 'record altered'],
    ['a valid record of another configuration in this directory', JSON.stringify(recordOf('Tiny.broken', keyA, 3)), 'record altered'],
    ['another format with a recomputed digest', sealed({ ...bodyOfA, format: 'momonga-tlc-result/2' }), 'record unreadable'],
    ['a file of 65 537 bytes', validText.padEnd(65537, ' '), 'record unreadable'],
  ];

  it.each(damagedFiles)('misses on %s', async (_label, content, reason) => {
    if (content !== undefined) placeFile('Tiny', keyA, content);
    expect(await createResultStore(dir).read('Tiny', keyA)).toEqual({ kind: 'miss', reason });
  });

  it('hits on the valid record the damaged files are made from', async () => {
    expect(validText).toContain('"distinctStates":3');
    expect(Buffer.byteLength(validText.padEnd(65537, ' '))).toBe(65537);
    placeFile('Tiny', keyA, validText);
    expect(await createResultStore(dir).read('Tiny', keyA)).toEqual({ kind: 'hit', record: recordOf('Tiny', keyA, 3) });
  });

  const failure = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

  const fileOps = (): StoreOps => ({
    mkdir: async (target) => {
      await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
    },
    writeExclusive: (file, text) => fs.promises.writeFile(file, text, { flag: 'wx', mode: 0o600 }),
    rename: (from, to) => fs.promises.rename(from, to),
    readFile: async (file, maxBytes) => {
      const handle = await fs.promises.open(file, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    readdir: async (target) => (await fs.promises.readdir(target, { withFileTypes: true })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
    mtimeMs: async (file) => (await fs.promises.stat(file)).mtimeMs,
    unlink: (file) => fs.promises.unlink(file),
    removeDirectory: (target) => fs.promises.rm(target, { recursive: true, force: true }),
    isProcessAlive: (pid) => pid === process.pid,
    pid: () => process.pid,
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  });

  type AsyncOperation = 'mkdir' | 'writeExclusive' | 'rename' | 'readFile' | 'readdir' | 'mtimeMs' | 'unlink' | 'removeDirectory';
  const ASYNC_OPERATIONS: readonly AsyncOperation[] = ['mkdir', 'writeExclusive', 'rename', 'readFile', 'readdir', 'mtimeMs', 'unlink', 'removeDirectory'];

  const rejecting = (operation: AsyncOperation, error: Error): StoreOps => ({ ...fileOps(), [operation]: () => Promise.reject(error) });

  const countingOps = (): { ops: StoreOps; calls: Record<AsyncOperation, unknown[][]> } => {
    const real = fileOps();
    const calls = Object.fromEntries(ASYNC_OPERATIONS.map((operation) => [operation, [] as unknown[][]])) as Record<AsyncOperation, unknown[][]>;
    const wrapped = Object.fromEntries(
      ASYNC_OPERATIONS.map((operation) => [
        operation,
        (...args: unknown[]) => {
          calls[operation].push(args);
          return (real[operation] as (...callArgs: unknown[]) => unknown)(...args);
        },
      ]),
    );
    return { ops: { ...real, ...wrapped } as StoreOps, calls };
  };

  const countsOf = (calls: Record<AsyncOperation, unknown[][]>): Record<AsyncOperation, number> =>
    Object.fromEntries(ASYNC_OPERATIONS.map((operation) => [operation, calls[operation].length])) as Record<AsyncOperation, number>;

  it.each([
    ['ENOENT', 'no record'],
    ['EIO', 'record unreadable'],
  ])('misses when reading the file fails with %s', async (code, reason) => {
    const key = keyNamed('one');
    expect(await createResultStore(dir).write(recordOf('Tiny', key, 3))).toEqual({ stored: true });
    expect(await createResultStore(dir, rejecting('readFile', failure(code))).read('Tiny', key)).toEqual({ kind: 'miss', reason });
  });

  it.each(['mkdir', 'writeExclusive', 'rename'] as const)('reports a write whose %s fails with the message of the error and leaves no record', async (operation) => {
    const key = keyNamed('one');
    expect(await createResultStore(dir, rejecting(operation, failure('EIO'))).write(recordOf('Tiny', key, 3))).toEqual({ stored: false, reason: 'injected EIO' });
    expect(fs.existsSync(recordPath('Tiny', key))).toBe(false);
  });

  it.each(['readdir', 'mtimeMs', 'unlink'] as const)('stores a record when %s fails during the prune', async (operation) => {
    const plain = createResultStore(dir);
    for (let index = 0; index < 8; index += 1) await plain.write(recordOf('Tiny', keyNamed(`k${index}`), 3));
    const ninth = keyNamed('k8');
    expect(await createResultStore(dir, rejecting(operation, failure('EIO'))).write(recordOf('Tiny', ninth, 3))).toEqual({ stored: true });
    expect(fs.existsSync(recordPath('Tiny', ninth))).toBe(true);
  });

  it('reports the message of the error when removing an orphan directory fails', async () => {
    fs.mkdirSync(path.join(dir, 'C'));
    expect(await createResultStore(dir, rejecting('removeDirectory', failure('EIO'))).removeOrphans(['A', 'B'])).toEqual({ removed: 0, reason: 'injected EIO' });
    expect(fs.existsSync(path.join(dir, 'C'))).toBe(true);
  });

  it('makes one call of each operation a first write needs and none it does not', async () => {
    const { ops, calls } = countingOps();
    expect(await createResultStore(dir, ops).write(recordOf('Tiny', keyNamed('one'), 3))).toEqual({ stored: true });
    expect(countsOf(calls)).toEqual({ mkdir: 1, writeExclusive: 1, rename: 1, readdir: 1, mtimeMs: 1, unlink: 0, readFile: 0, removeDirectory: 0 });
  });

  it('reads one file of at most 65 537 bytes and touches nothing else', async () => {
    const key = keyNamed('one');
    await createResultStore(dir).write(recordOf('Tiny', key, 3));
    const { ops, calls } = countingOps();
    expect((await createResultStore(dir, ops).read('Tiny', key)).kind).toBe('hit');
    expect(countsOf(calls)).toEqual({ mkdir: 0, writeExclusive: 0, rename: 0, readdir: 0, mtimeMs: 0, unlink: 0, readFile: 1, removeDirectory: 0 });
    expect(calls.readFile[0]).toEqual([recordPath('Tiny', key), 65537]);
  });

  it('lists the store once and opens no file when it removes one orphan', async () => {
    await createResultStore(dir).write(recordOf('Tiny', keyNamed('one'), 3));
    fs.mkdirSync(path.join(dir, 'Old'));
    const { ops, calls } = countingOps();
    expect(await createResultStore(dir, ops).removeOrphans(['Tiny'])).toEqual({ removed: 1 });
    expect(calls.readdir).toEqual([[dir]]);
    expect(calls.removeDirectory).toEqual([[path.join(dir, 'Old')]]);
    expect(calls.readFile).toEqual([]);
  });

  it('leaves exactly the record file after a write', async () => {
    const key = keyNamed('one');
    expect(await createResultStore(dir).write(recordOf('Tiny', key, 3))).toEqual({ stored: true });
    expect(fs.readdirSync(path.join(dir, 'Tiny'))).toEqual([`${key}.json`]);
  });

  it('reports a write it could not make without throwing', async () => {
    fs.writeFileSync(path.join(dir, 'Tiny'), 'not a directory');
    const outcome = (await createResultStore(dir).write(recordOf('Tiny', keyNamed('one'), 3))) as { stored: boolean; reason?: string };
    expect(outcome.stored).toBe(false);
    expect(typeof outcome.reason).toBe('string');
    expect((outcome.reason as string).length).toBeGreaterThan(0);
  });

  it('keeps the eight newest records of a configuration and leaves other configurations alone', async () => {
    const store = createResultStore(dir);
    const keys = Array.from({ length: 8 }, (_, index) => keyNamed(`k${index}`));
    for (const key of keys) await store.write(recordOf('Tiny', key, 3));
    const otherKey = keyNamed('other');
    await store.write(recordOf('Tiny.broken', otherKey, 3));
    const base = new Date('2026-01-01T00:00:00.000Z').getTime() / 1000;
    keys.forEach((key, index) => fs.utimesSync(path.join(dir, 'Tiny', `${key}.json`), base + index, base + index));
    fs.utimesSync(path.join(dir, 'Tiny.broken', `${otherKey}.json`), base - 100, base - 100);
    const ninth = keyNamed('k8');
    await store.write(recordOf('Tiny', ninth, 3));
    expect(fs.readdirSync(path.join(dir, 'Tiny')).sort()).toEqual([...keys.slice(1), ninth].map((key) => `${key}.json`).sort());
    expect(fs.readdirSync(path.join(dir, 'Tiny.broken'))).toEqual([`${otherKey}.json`]);
  });

  it('keeps the smaller file name of two records written at the same time', async () => {
    const store = createResultStore(dir);
    const [smaller, larger] = [keyNamed('tie-a'), keyNamed('tie-b')].sort() as [string, string];
    const rest = Array.from({ length: 6 }, (_, index) => keyNamed(`r${index}`));
    for (const key of [smaller, larger, ...rest]) await store.write(recordOf('Tiny', key, 3));
    const base = new Date('2026-01-01T00:00:00.000Z').getTime() / 1000;
    fs.utimesSync(path.join(dir, 'Tiny', `${smaller}.json`), base, base);
    fs.utimesSync(path.join(dir, 'Tiny', `${larger}.json`), base, base);
    rest.forEach((key, index) => fs.utimesSync(path.join(dir, 'Tiny', `${key}.json`), base + 1 + index, base + 1 + index));
    const ninth = keyNamed('n');
    await store.write(recordOf('Tiny', ninth, 3));
    const left = fs.readdirSync(path.join(dir, 'Tiny'));
    expect(left).toContain(`${smaller}.json`);
    expect(left).not.toContain(`${larger}.json`);
    expect(left).toHaveLength(8);
  });

  it('removes the temporary file of a dead writer and keeps that of a live one', async () => {
    const finished = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    const deadPid = finished.pid as number;
    await new Promise((resolve) => finished.once('exit', resolve));
    const key = keyNamed('tmp');
    const deadTmp = `.${key}.${deadPid}.0123abcd.tmp`;
    const liveTmp = `.${key}.${process.pid}.89abcdef.tmp`;
    fs.mkdirSync(path.join(dir, 'Tiny'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Tiny', deadTmp), 'partial');
    fs.writeFileSync(path.join(dir, 'Tiny', liveTmp), 'partial');
    await createResultStore(dir).write(recordOf('Tiny', keyNamed('written'), 3));
    const left = fs.readdirSync(path.join(dir, 'Tiny'));
    expect(left).not.toContain(deadTmp);
    expect(left).toContain(liveTmp);
  });

  it('removes the directories of configurations that are not listed and nothing else', async () => {
    const store = createResultStore(dir);
    await store.write(recordOf('A', keyNamed('a'), 3));
    await store.write(recordOf('B', keyNamed('b'), 3));
    fs.mkdirSync(path.join(dir, 'C'));
    fs.writeFileSync(path.join(dir, 'C', `${keyNamed('c')}.json`), '{ damaged');
    fs.writeFileSync(path.join(dir, 'stray'), 'stray');
    expect(await store.removeOrphans(['A', 'B'])).toEqual({ removed: 1 });
    expect(fs.existsSync(path.join(dir, 'C'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'A'))).toEqual([`${keyNamed('a')}.json`]);
    expect(fs.readdirSync(path.join(dir, 'B'))).toEqual([`${keyNamed('b')}.json`]);
    expect(fs.readFileSync(path.join(dir, 'stray'), 'utf8')).toBe('stray');
  });

  it('stores both of two parallel writes of one key as one file', async () => {
    const store = createResultStore(dir);
    const key = keyNamed('race');
    const outcomes = await Promise.all([store.write(recordOf('Tiny', key, 3)), store.write(recordOf('Tiny', key, 3))]);
    expect(outcomes).toEqual([{ stored: true }, { stored: true }]);
    expect(fs.readdirSync(path.join(dir, 'Tiny'))).toEqual([`${key}.json`]);
    expect(await store.read('Tiny', key)).toEqual({ kind: 'hit', record: recordOf('Tiny', key, 3) });
  });
});

describe('one definition of the record format', () => {
  it('is written in reuse.ts and in no other source of test/formal', () => {
    const formalDir = import.meta.dirname;
    const defining = fs
      .readdirSync(formalDir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => fs.readFileSync(path.join(formalDir, name), 'utf8').includes('momonga-tlc-result/1'));
    expect(defining).toEqual(['reuse.ts']);
  });
});

describe('the inputs TLC can load from the specification directory', () => {
  it('are only modules, configurations, the manifest and JSON inputs, each of which the key covers', () => {
    const specDir = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla');
    const others = fs
      .readdirSync(specDir, { withFileTypes: true })
      .filter((entry) => !(entry.isFile() && (entry.name.endsWith('.tla') || entry.name.endsWith('.cfg') || entry.name.endsWith('.json'))))
      .map((entry) => entry.name);
    expect(others).toEqual([]);
  });
});
