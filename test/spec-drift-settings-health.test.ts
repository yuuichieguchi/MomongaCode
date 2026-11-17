import fs from 'node:fs';
import path from 'node:path';
import { moduleHeaderOf } from './formal/manifest.ts';
import { describe, expect, it, vi } from 'vitest';
import { createUserSettingsCache } from '@momonga/config';
import type { KeptRecords } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson, writeText } from '../packages/config/test/helpers.ts';
import { cfgNames } from './formal/cfg-names.ts';
import { readManifest } from './formal/manifest.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');
const specDir = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'SettingsHealth.tla'), 'utf8');

const sourcesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist' ? [] : sourcesOf(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const relative = (file: string): string => path.relative(packagesDir, file).split(path.sep).join('/');

const productSources = fs
  .readdirSync(packagesDir)
  .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
  .flatMap((name) => sourcesOf(path.join(packagesDir, name, 'src')))
  .map(relative)
  .sort();

const textOf = (file: string): string => fs.readFileSync(path.join(packagesDir, file), 'utf8');

const filesMatching = (pattern: RegExp): string[] => productSources.filter((file) => pattern.test(textOf(file)));

const headerText = (): string => {
  return moduleHeaderOf('SettingsHealth')
    .split('\n')
    .map((line) => line.replace(/^\s*\(\*+/, '').replace(/\*+\)\s*$/, '').trim())
    .join(' ')
    .replace(/\/\s+/g, '/');
};

const sectionOf = (start: string, next: string): string => {
  const header = headerText();
  const from = header.indexOf(start);
  const to = header.indexOf(next, from);
  if (from === -1 || to === -1) throw new Error(`section ${start} is not in the header of SettingsHealth.tla`);
  return header.slice(from, to);
};

const resolve = (token: string): string => {
  const stripped = token.replace(/^packages\//, '');
  const found = productSources.filter((file) => file.startsWith('runtime/src/') && (file === stripped || file.endsWith(`/${stripped}`)));
  if (found.length !== 1) throw new Error(`${token} in SettingsHealth.tla names ${found.length} source files: ${found.join(', ')}`);
  return found[0] as string;
};

const filesIn = (section: string): string[] => [...new Set([...section.matchAll(/[\w./-]+\.ts/g)].map((match) => resolve(match[0])))].sort();

const ADMISSION = filesIn(sectionOf('admission readers', 'in-run readers'));
const IN_RUN = filesIn(sectionOf('in-run readers', 'a background reader'));
const BACKGROUND = filesIn(sectionOf('a background reader', 'readers that start no new work'));
const VIEW = filesIn(sectionOf('readers that start no new work', 'the kept copy'));

const ADMIT_CALL = /\badmitUserSnapshot\(/;
const SESSION_CREATE_CALL = /\bsessionCreateSettings\(/;
const IN_RUN_READ = /takeUserSnapshot\(\)|\.userSnapshot\(|loadSessionSettings\(|settings\.(rules|hooks|verification|memory|context|tools|trusted|approvedProjectAgents|appendRule|autoModeClassifier)\(/;
const CACHE_CALL = /\bcache\.(snapshot|read|load|loadOrKeep)\(/;


describe('the code follows SettingsHealth.tla (one rule for every settings file)', () => {
  it('the header of the model names the admission, in-run and background readers', () => {
    expect(ADMISSION).toEqual([
      'runtime/src/process/mcp-admin.ts',
      'runtime/src/process/settings-port.ts',
      'runtime/src/process/start-runtime-process.ts',
      'runtime/src/service/app.ts',
    ]);
    const codeReaders = filesMatching(IN_RUN_READ).filter((file) => file.startsWith('runtime/src/') && !ADMISSION.includes(file));
    expect(codeReaders.length).toBeGreaterThan(0);
    expect(codeReaders.filter((file) => !IN_RUN.includes(file))).toEqual([]);
    expect(BACKGROUND).toEqual(['runtime/src/process/start-runtime-process.ts']);
    expect(VIEW).toEqual(['runtime/src/service/app.ts']);
  });

  it('only the admission readers of the model call admitUserSnapshot', () => {
    expect(filesMatching(ADMIT_CALL)).toEqual(['runtime/src/process/mcp-admin.ts', 'runtime/src/process/settings-port.ts']);
    for (const file of filesMatching(ADMIT_CALL)) expect(ADMISSION).toContain(file);
  });

  it('only the admission readers of the model call sessionCreateSettings', () => {
    expect(filesMatching(SESSION_CREATE_CALL)).toEqual([
      'runtime/src/process/settings-port.ts',
      'runtime/src/process/start-runtime-process.ts',
      'runtime/src/service/app.ts',
    ]);
    for (const file of filesMatching(SESSION_CREATE_CALL)) expect(ADMISSION).toContain(file);
  });

  it('no in-run or background reader of the model reaches admission', () => {
    for (const file of [...IN_RUN, ...BACKGROUND].filter((reader) => !ADMISSION.includes(reader))) {
      expect(textOf(file), file).not.toMatch(ADMIT_CALL);
      expect(textOf(file), file).not.toMatch(SESSION_CREATE_CALL);
    }
    const process = textOf('runtime/src/process/start-runtime-process.ts');
    const sweep = process.slice(process.indexOf('startMemorySweeper('));
    expect(process.indexOf('startMemorySweeper(')).toBeGreaterThan(process.indexOf('sessionCreateSettings: async'));
    expect(sweep).not.toMatch(SESSION_CREATE_CALL);
    expect(sweep).not.toMatch(ADMIT_CALL);
  });

  it('the run-creating call is admission: createRun goes through sessionSettingsOf with the request signal (Admit)', () => {
    const app = textOf('runtime/src/service/app.ts');
    const start = app.indexOf('const createRun: Handler');
    const end = app.indexOf('\n  };\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(app.slice(start, end)).toMatch(/await admittedTermsOf\(\s*session,[\s\S]*?,\s*context\.req\.raw\.signal,?\s*\)/);
    const termsStart = app.indexOf('const admittedTermsOf = async (session: Session, request: RunTermsRequest, signal: AbortSignal)');
    const termsEnd = app.indexOf('\n  };\n', termsStart);
    expect(termsStart).toBeGreaterThan(-1);
    expect(app.slice(termsStart, termsEnd)).toMatch(/=> \{\n\s*await sessionSettingsOf\(session\.cwd, signal\);/);
  });

  it('the readers that start no new work go through the read use: sessionViewOf and patchSession never call sessionSettingsOf (View)', () => {
    const app = textOf('runtime/src/service/app.ts');
    for (const name of ['const sessionViewOf', 'const patchSession: Handler']) {
      const start = app.indexOf(name);
      const end = app.indexOf('\n  };\n', start);
      expect(start, name).toBeGreaterThan(-1);
      const body = app.slice(start, end);
      expect(body, name).not.toMatch(/sessionSettingsOf\(/);
      expect(body, name).toMatch(/sessionReadSettingsOf\(/);
    }
  });

  it('the kept copy of the model is one store for every file, used by the user cache and the project and local layers (Persist)', () => {
    expect(filesMatching(/\bcreateKeptSettings\(/)).toEqual(['config/src/kept-settings.ts', 'config/src/user-settings.ts']);
    expect(textOf('config/src/layers.ts')).toMatch(/kept\.store\.(recall|remember)\(/);
  });

  it('only the settings composition reads the user settings cache in the runtime, through a load from disk for admission and read in a Run', () => {
    expect(filesMatching(CACHE_CALL).filter((file) => file.startsWith('runtime/'))).toEqual(['runtime/src/process/settings-port.ts']);
    const port = textOf('runtime/src/process/settings-port.ts');
    expect(port).toMatch(/const admitUserSnapshot = async \(signal: AbortSignal\): Promise<UserSnapshot> => \{\n\s*const snapshot = await cache\.load\(signal\);/);
    expect(port).toMatch(/\bcache\.read\(\)/);
  });

  it('the holding configuration is the design the code builds, and every configuration is in the manifest', () => {
    expect(cfgNames(specDir, 'SettingsHealth').constants).toMatchObject({ ReadMode: '"lastGood"', AdmitMode: '"disk"', StartMode: '"refuse"', NameFile: 'TRUE' });
    const configs = fs.readdirSync(specDir).filter((file) => /^SettingsHealth(\.\w+)?\.cfg$/.test(file)).map((file) => file.slice(0, -'.cfg'.length)).sort();
    const entries = readManifest(path.join(specDir, 'manifest.json')).entries.filter((entry) => entry.config.startsWith('SettingsHealth'));
    expect(entries.map((entry) => entry.config).sort()).toEqual(configs);
    expect(entries.find((entry) => entry.config === 'SettingsHealth')?.expect).toBe('holds');
  });
});

type HealthStep = 'edit1' | 'edit2' | 'break' | 'admit' | 'read' | 'crash';

const HEALTH_STEPS: readonly HealthStep[] = ['edit1', 'edit2', 'break', 'admit', 'read', 'crash'];

const healthRuns = (length: number): HealthStep[][] => {
  let runs: HealthStep[][] = [[]];
  for (let index = 0; index < length; index += 1) runs = runs.flatMap((run) => HEALTH_STEPS.map((step) => [...run, step]));
  return runs;
};

const memoryKeptRecords = (): KeptRecords => {
  const records = new Map<string, Parameters<KeptRecords['save']>[1]>();
  return { load: async (file) => records.get(file), save: async (file, read) => void records.set(file, read) };
};

describe('the user settings cache does what SettingsHealth.tla states, on the edit, admission, in-run read and crash sequences of the model', () => {
  it('admission refuses a broken file and names it (AdmittedOnlyWhenValid, RefusalNamesFile); an in-run read never throws and returns the current valid version, or the last good copy while the file is broken, across a crash (NoReaderThrows, ReadsValid, ReadsCurrent, Persist)', async () => {
    const config = cfgNames(specDir, 'SettingsHealth');
    expect(config.constants).toMatchObject({ ReadMode: '"lastGood"', AdmitMode: '"disk"', NameFile: 'TRUE', Persist: 'TRUE' });
    const signal = new AbortController().signal;
    const failures: string[] = [];
    for (const run of healthRuns(4)) {
      const tree = makeTree();
      const file = userSettingsPath(tree);
      const kept = memoryKeptRecords();
      const cacheOf = () => createUserSettingsCache({ env: process.env, home: tree.home, onWarning: () => undefined, keptRecords: kept });
      writeJson(file, { env: { TZ: 'v1' } });
      let cache = cacheOf();
      await cache.loadOrKeep(signal);
      let disk = 1;
      let lastGood = 1;
      for (const step of run) {
        const where = `${run.join(' ')} at ${step}`;
        if (step === 'edit1' || step === 'edit2') {
          disk = step === 'edit1' ? 1 : 2;
          writeJson(file, { env: { TZ: `v${disk}` } });
        } else if (step === 'break') {
          disk = 0;
          writeText(file, '{ "env": ');
        } else if (step === 'crash') {
          cache = cacheOf();
        } else if (step === 'admit') {
          const snapshot = await cache.load(signal);
          if (disk === 0) {
            if (!('error' in snapshot)) failures.push(`${where}: a broken file was admitted`);
            else if (!snapshot.error.message.includes(file)) failures.push(`${where}: the refusal does not name ${file}`);
          } else if ('error' in snapshot) failures.push(`${where}: a valid file was refused`);
          else if (snapshot.settings.env['TZ'] !== `v${disk}`) failures.push(`${where}: admission read ${String(snapshot.settings.env['TZ'])}, not v${disk}`);
          if (disk !== 0) lastGood = disk;
        } else {
          const expected = disk === 0 ? lastGood : disk;
          const read = await cache.loadOrKeep(signal).then(
            (loaded) => String(loaded.settings.env['TZ']),
            (error: unknown) => `threw ${error instanceof Error ? error.message : String(error)}`,
          );
          if (read !== `v${expected}`) failures.push(`${where}: the in-run read got ${read}, not v${expected}`);
          if (disk !== 0) lastGood = disk;
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});
