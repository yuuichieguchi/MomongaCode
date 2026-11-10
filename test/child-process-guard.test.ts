import childProcessDefault, * as childProcessNamespace from 'node:child_process';
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SECRET_PROGRAM_ENV } from '@momonga/foundation';
import { spawnTracked } from '@momonga/testkit';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFUSAL = /resolves the secret store to .*outside the fake directory/;
const LEAKING_ENV = { PATH: '/usr/bin:/bin' };

const markerDir = (): string => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guard-'));
const writerArgs = (marker: string): string[] => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`];
const writerCommand = (marker: string): string => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`)}`;

const expectRefusedBeforeLaunch = async (launch: (marker: string) => unknown): Promise<void> => {
  const dir = markerDir();
  const marker = path.join(dir, 'ran');
  try {
    let refusal: unknown;
    try {
      await launch(marker);
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(REFUSAL);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const require = createRequire(import.meta.url);

describe('no child process of a test run gets an env that resolves a real secret store program', () => {
  it.each([
    ['named spawn', (marker: string) => spawn(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['named spawnSync', (marker: string) => spawnSync(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['named execFile', (marker: string) => execFile(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['named execFileSync', (marker: string) => execFileSync(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['named exec', (marker: string) => exec(writerCommand(marker), { env: LEAKING_ENV })],
    ['named execSync', (marker: string) => execSync(writerCommand(marker), { env: LEAKING_ENV })],
    ['named fork', (marker: string) => fork('-e', [], { env: LEAKING_ENV, execArgv: writerArgs(marker) })],
    ['default import', (marker: string) => childProcessDefault.spawn(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['namespace import', (marker: string) => childProcessNamespace.spawnSync(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['createRequire', (marker: string) => (require('node:child_process') as typeof childProcessDefault).execFileSync(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['aliased promisify(execFile)', (marker: string) => promisify(execFile)(process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['a wrapper around spawnTracked', (marker: string) => spawnTracked({ onTestFinished: () => undefined }, process.execPath, writerArgs(marker), { env: LEAKING_ENV })],
    ['a template-literal program path', (marker: string) => execFileSync(`${path.dirname(process.execPath)}/${path.basename(process.execPath)}`, writerArgs(marker), { env: LEAKING_ENV })],
    ['a directly given MOMONGA_SECRET_PROGRAM without PATH', (marker: string) => spawnSync(process.execPath, writerArgs(marker), { env: { [SECRET_PROGRAM_ENV]: '/usr/bin/security' } })],
  ])('refuses a leaking env before the launch: %s', async (_route, launch) => {
    await expectRefusedBeforeLaunch(launch);
  });

  it.each([
    ['packages/cli/src/main.ts', ['--version']],
    ['packages/gateway/src/bin.ts', []],
    ['packages/runtime/src/bin.ts', []],
    ['e2e/support/gateway-secrets-main.ts', []],
    ['packages/cli/dist/main.js', ['--version']],
  ])('refuses to start the product entry %s with a leaking env', async (entry, args) => {
    await expectRefusedBeforeLaunch(() => promisify(execFile)(process.execPath, [path.join(ROOT, entry), ...args], { env: { PATH: process.env['PATH']?.split(path.delimiter).slice(1).join(path.delimiter) ?? '' } }));
  });

  it('an env without PATH resolves no program and is allowed', () => {
    expect(spawnSync(process.execPath, ['-e', ''], { env: {} }).status).toBe(0);
  });

  it('node-pty, which bypasses node:child_process, is imported by no test source', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
        return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
      });
    const roots = ['e2e', 'scripts', 'test', ...fs.readdirSync(path.join(ROOT, 'packages')).flatMap((name) => [`packages/${name}/test`, ...(name === 'testkit' ? ['packages/testkit/src'] : [])])];
    const importers = roots
      .map((dir) => path.join(ROOT, dir))
      .filter((dir) => fs.existsSync(dir))
      .flatMap(walk)
      .filter((file) => /['"]node-pty['"]/.test(fs.readFileSync(file, 'utf8')) && file !== path.join(ROOT, 'test/child-process-guard.test.ts'));
    expect(importers).toEqual([]);
  });
});
