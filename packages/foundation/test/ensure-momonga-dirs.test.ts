import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-home-'));
  tempDirs.push(dir);
  return dir;
};

const directoriesOf = (paths: ReturnType<typeof momongaPaths>): string[] => [
  paths.root,
  paths.run,
  paths.markers.root,
  paths.markers.tools,
  paths.markers.mcp,
  paths.markers.targets,
  paths.markers.daemons,
  paths.state,
  paths.traces.dir,
  paths.probe,
  paths.logs,
  paths.projects,
  paths.skills,
  paths.cacheBase,
  paths.tmp.root,
  paths.tmp.spawn,
  paths.tmp.sessions,
];

const modeOf = (dir: string): number => fs.lstatSync(dir).mode & 0o777;

describe('ensureMomongaDirs', () => {
  it('creates every directory as a real 0700 directory', async () => {
    const paths = momongaPaths(makeHome(), 'darwin', {});
    await ensureMomongaDirs(paths);
    for (const dir of directoriesOf(paths)) {
      const stat = fs.lstatSync(dir);
      expect(stat.isDirectory(), dir).toBe(true);
      expect(stat.mode & 0o777, dir).toBe(0o700);
    }
    expect(fs.existsSync(paths.settingsFile)).toBe(false);
  });

  it('is idempotent', async () => {
    const paths = momongaPaths(makeHome(), 'darwin', {});
    await ensureMomongaDirs(paths);
    await ensureMomongaDirs(paths);
    expect(modeOf(paths.run)).toBe(0o700);
  });

  it('tightens an existing 0755 directory owned by the user to 0700', async () => {
    const paths = momongaPaths(makeHome(), 'darwin', {});
    fs.mkdirSync(paths.state, { recursive: true });
    fs.chmodSync(paths.root, 0o755);
    fs.chmodSync(paths.state, 0o755);
    await ensureMomongaDirs(paths);
    expect(modeOf(paths.root)).toBe(0o700);
    expect(modeOf(paths.state)).toBe(0o700);
  });

  it('refuses a symlinked directory inside .momonga and names it', async () => {
    const home = makeHome();
    const paths = momongaPaths(home, 'darwin', {});
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(paths.root, { mode: 0o700 });
    fs.symlinkSync(elsewhere, paths.run);
    await expect(async () => ensureMomongaDirs(paths)).rejects.toThrow(paths.run);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a symlinked .momonga root', async () => {
    const home = makeHome();
    const paths = momongaPaths(home, 'darwin', {});
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(elsewhere, paths.root);
    await expect(async () => ensureMomongaDirs(paths)).rejects.toThrow(/symlink/i);
  });

  it('refuses a symlinked cache base', async () => {
    const home = makeHome();
    const paths = momongaPaths(home, 'darwin', {});
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(path.dirname(paths.cacheBase), { recursive: true });
    fs.symlinkSync(elsewhere, paths.cacheBase);
    await expect(async () => ensureMomongaDirs(paths)).rejects.toThrow(paths.cacheBase);
  });

  it('accepts a home reached through a symlinked ancestor', async () => {
    const base = makeHome();
    const real = path.join(base, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    const paths = momongaPaths(path.join(link), 'darwin', {});
    await ensureMomongaDirs(paths);
    expect(fs.lstatSync(path.join(real, '.momonga', 'run')).isDirectory()).toBe(true);
    expect(modeOf(path.join(real, '.momonga', 'run'))).toBe(0o700);
  });
});

describe('ensureMomongaDirs under concurrency', () => {
  it('lets concurrent callers in one process create a fresh home', async () => {
    const paths = momongaPaths(makeHome(), 'darwin', {});
    await Promise.all([ensureMomongaDirs(paths), ensureMomongaDirs(paths), ensureMomongaDirs(paths), ensureMomongaDirs(paths)]);
    for (const dir of directoriesOf(paths)) expect(modeOf(dir), dir).toBe(0o700);
  });

  it('lets concurrent child processes create a fresh home', { timeout: 30_000 }, async () => {
    const home = makeHome();
    const entry = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts')).href;
    const script = `const f = await import(${JSON.stringify(entry)}); await f.ensureMomongaDirs(f.momongaPaths(${JSON.stringify(home)}, 'darwin', {}));`;
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolve) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
            child.once('exit', (code) => resolve(`${code}${code === 0 ? '' : `: ${stderr}`}`));
          }),
      ),
    );
    expect(codes).toEqual(['0', '0', '0', '0', '0', '0']);
    for (const dir of directoriesOf(momongaPaths(home, 'darwin', {}))) expect(modeOf(dir), dir).toBe(0o700);
  });
});

describe('ensureMomongaDirs daemon markers', () => {
  it('creates markers/daemons with mode 0700', async (context) => {
    const paths = momongaPaths(withTempDir(context), 'darwin', {});
    await ensureMomongaDirs(paths);
    const stat = fs.lstatSync(paths.markers.daemons);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('tightens an existing 0755 markers/daemons to 0700', async (context) => {
    const paths = momongaPaths(withTempDir(context), 'darwin', {});
    fs.mkdirSync(paths.markers.daemons, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.markers.daemons, 0o755);
    await ensureMomongaDirs(paths);
    expect(modeOf(paths.markers.daemons)).toBe(0o700);
  });
});
