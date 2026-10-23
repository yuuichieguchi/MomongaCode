import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSeatbeltSandbox, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { killGroup, makeTempDir, run } from './helpers.ts';

const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const MARKER_CONTENT = 'marker-content';

const readLinesUntil = async (stream: AsyncIterable<Uint8Array>, done: (lines: string[]) => boolean): Promise<string[]> => {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString('utf8');
    const lines = buffer.split('\n').slice(0, -1);
    if (done(lines)) return lines;
  }
  return buffer.split('\n').filter((line) => line !== '');
};

const holdersOf = (file: string): number[] => {
  try {
    return execFileSync('/usr/sbin/lsof', ['-t', '--', file], { env: { LC_ALL: 'C' }, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
  } catch {
    return [];
  }
};

const variants: Array<[string, (tmpRoot: string) => Sandbox]> = [
  ['seatbelt', (tmpRoot) => createSeatbeltSandbox({ tmpRoot, killGraceMs: 300 })],
  ['unsandboxed', () => createUnsandboxed({ killGraceMs: 300 })],
];

describe.runIf(process.platform === 'darwin').each(variants)('marker file as fd 3 (%s)', (kind, make) => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let controllers: AbortController[] = [];
  let root = '';
  let sandbox: Sandbox;

  const tempDir = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
    writableRoots: [root],
    writeDenied: [],
    readDenied: [],
    network: 'deny',
    ...overrides,
  });

  const sh = (script: string, markerFile: string | undefined, overrides: Partial<SandboxPolicy> = {}): SandboxedProcess => {
    const controller = new AbortController();
    controllers.push(controller);
    const command = markerFile === undefined
      ? { argv: ['/bin/sh', '-c', script], cwd: root, env: BASE_ENV }
      : { argv: ['/bin/sh', '-c', script], cwd: root, env: BASE_ENV, markerFile };
    const proc = sandbox.spawn(command, policy(overrides), controller.signal);
    spawned.push(proc);
    return proc;
  };

  const makeMarker = (dir: string): string => {
    const marker = path.join(dir, 'marker');
    fs.writeFileSync(marker, MARKER_CONTENT, { mode: 0o600 });
    return marker;
  };

  beforeEach(() => {
    root = tempDir();
    sandbox = make(tempDir());
  });

  afterEach(() => {
    for (const proc of spawned) killGroup(proc.pgid);
    for (const controller of controllers) controller.abort();
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    created = [];
    spawned = [];
    controllers = [];
  });

  it('lets the child read the marker through fd 3', async () => {
    const marker = makeMarker(tempDir());
    const result = await run(sh('cat <&3', marker));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(MARKER_CONTENT);
  });

  it('makes the child and its grandchild visible as marker holders while running, but not the parent', async () => {
    const marker = makeMarker(tempDir());
    const proc = sh('sleep 30 & echo "ready $!"; wait', marker);
    const lines = await readLinesUntil(proc.stdout, (current) => current.some((line) => line.startsWith('ready ')));
    const sleepPid = Number(lines.find((line) => line.startsWith('ready '))?.slice('ready '.length));
    const holders = holdersOf(marker);
    expect(holders).toContain(proc.pid);
    expect(holders).toContain(sleepPid);
    expect(holders).not.toContain(process.pid);
  });

  it('does not open fd 3 in the child without a marker file', async () => {
    const result = await run(sh('if { true <&3; } 2>/dev/null; then echo open; else echo closed; fi', undefined));
    expect(result.stdout).toBe('closed\n');
  });

  it('fails to spawn with an error naming a missing marker file', () => {
    const missing = path.join(tempDir(), 'missing-marker');
    let error: unknown;
    try {
      sh('true', missing);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(missing);
  });

  it.runIf(kind === 'seatbelt')('passes the marker even when the profile denies reading its path', async () => {
    const secret = tempDir();
    const marker = makeMarker(secret);
    const script = `cat <&3; echo; if cat '${marker}' >/dev/null 2>&1; then echo path-ok; else echo path-denied; fi`;
    const result = await run(sh(script, marker, { readDenied: [secret] }));
    expect(result.stdout).toBe(`${MARKER_CONTENT}\npath-denied\n`);
  });
});
