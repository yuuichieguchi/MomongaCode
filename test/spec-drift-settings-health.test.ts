import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifest } from './formal/manifest.ts';

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
  const end = spec.indexOf('EXTENDS');
  return spec
    .slice(0, end)
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
const CACHE_CALL = /\bcache\.(snapshot|read)\(/;

const configOf = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');
const constantOf = (cfg: string, name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(cfg);
  if (match === null) throw new Error(`${name} is not set`);
  return match[1] as string;
};

describe('the code follows SettingsHealth.tla (one rule for every settings file)', () => {
  it('the header of the model names the admission, in-run and background readers', () => {
    expect(ADMISSION).toEqual(['runtime/src/process/mcp-admin.ts', 'runtime/src/process/settings-port.ts', 'runtime/src/service/app.ts']);
    expect(IN_RUN.length).toBeGreaterThanOrEqual(12);
    expect(BACKGROUND).toEqual(['runtime/src/process/start-runtime-process.ts']);
    expect(VIEW).toEqual(['runtime/src/service/app.ts']);
  });

  it('only the admission readers of the model call admitUserSnapshot', () => {
    expect(filesMatching(ADMIT_CALL)).toEqual(['runtime/src/process/mcp-admin.ts', 'runtime/src/process/settings-port.ts']);
    for (const file of filesMatching(ADMIT_CALL)) expect(ADMISSION).toContain(file);
  });

  it('no in-run or background reader of the model reaches admission', () => {
    for (const file of [...IN_RUN, ...BACKGROUND].filter((reader) => !ADMISSION.includes(reader))) {
      expect(textOf(file), file).not.toMatch(ADMIT_CALL);
      expect(textOf(file), file).not.toMatch(/\bsessionCreateSettings\(/);
    }
  });

  it('the run-creating call is admission: createRun goes through sessionSettingsOf (Admit)', () => {
    const app = textOf('runtime/src/service/app.ts');
    const start = app.indexOf('const createRun: Handler');
    const end = app.indexOf('\n  };\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(app.slice(start, end)).toMatch(/await sessionSettingsOf\(session\.cwd\)/);
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

  it('only the settings composition reads the user settings cache in the runtime, through snapshot for admission and read in a Run', () => {
    expect(filesMatching(CACHE_CALL).filter((file) => file.startsWith('runtime/'))).toEqual(['runtime/src/process/settings-port.ts']);
    const port = textOf('runtime/src/process/settings-port.ts');
    expect(port).toMatch(/\bcache\.snapshot\(\)/);
    expect(port).toMatch(/\bcache\.read\(\)/);
  });

  it('the holding configuration is the design the code builds, and every configuration is in the manifest', () => {
    const cfg = configOf('SettingsHealth');
    expect(constantOf(cfg, 'ReadMode')).toBe('"lastGood"');
    expect(constantOf(cfg, 'AdmitMode')).toBe('"disk"');
    expect(constantOf(cfg, 'StartMode')).toBe('"refuse"');
    expect(constantOf(cfg, 'NameFile')).toBe('TRUE');
    const configs = fs.readdirSync(specDir).filter((file) => /^SettingsHealth(\.\w+)?\.cfg$/.test(file)).map((file) => file.slice(0, -'.cfg'.length)).sort();
    const entries = readManifest(path.join(specDir, 'manifest.json')).entries.filter((entry) => entry.config.startsWith('SettingsHealth'));
    expect(entries.map((entry) => entry.config).sort()).toEqual(configs);
    expect(entries.find((entry) => entry.config === 'SettingsHealth')?.expect).toBe('holds');
  });
});
