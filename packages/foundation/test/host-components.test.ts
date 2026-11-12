import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { createTempDir, systemTempRoot } from '@momonga/testkit';

type ExecCall = { file: string; args: readonly string[]; signal: AbortSignal | undefined };
type ExecAnswer = { exitCode: number; stdout: string; stderr: string };
type Reading = { kind: 'read'; value: string } | { kind: 'unreadable'; reason: string };
type ReadComponents = (request: {
  identity: readonly string[];
  binary: string;
  platform: NodeJS.Platform;
  exec: (file: string, args: readonly string[], options: { signal: AbortSignal }) => Promise<ExecAnswer>;
  signal: AbortSignal;
}) => Promise<Record<string, Reading>>;

const readProbeKeyComponents: ReadComponents = (request) => {
  const value = (foundation as Record<string, unknown>)['readProbeKeyComponents'];
  if (value === undefined) throw new Error('@momonga/foundation does not export readProbeKeyComponents');
  return (value as ReadComponents)(request);
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const binaryWith = (bytes: string): string => {
  const dir = createTempDir();
  dirs.push(dir);
  const file = path.join(dir, 'server');
  fs.writeFileSync(file, bytes, { mode: 0o755 });
  return file;
};

const recordingExec = (answer: ExecAnswer) => {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: async (file: string, args: readonly string[], options: { signal: AbortSignal }): Promise<ExecAnswer> => {
      calls.push({ file, args, signal: options.signal });
      return answer;
    },
  };
};

const FM_IDENTITY = ['binarySha256', 'hostOsBuild'];

describe('one reader per probe key component (design-managed-servers section 6.2, item 10 of section 17)', () => {
  it('hashes the bytes of the target binary and reads the OS build with sw_vers -buildVersion on PATH under the asking signal', async () => {
    const binary = binaryWith('#!/bin/sh\necho fake\n');
    const { calls, exec } = recordingExec({ exitCode: 0, stdout: '25A354\n', stderr: '' });
    const asking = new AbortController().signal;
    const readings = await readProbeKeyComponents({ identity: FM_IDENTITY, binary, platform: 'darwin', exec, signal: asking });
    expect(readings).toEqual({
      binarySha256: { kind: 'read', value: createHash('sha256').update('#!/bin/sh\necho fake\n').digest('hex') },
      hostOsBuild: { kind: 'read', value: '25A354' },
    });
    expect(calls).toEqual([{ file: 'sw_vers', args: ['-buildVersion'], signal: asking }]);
  });

  it('reads only the components the description lists', async () => {
    const binary = binaryWith('kind two');
    const { calls, exec } = recordingExec({ exitCode: 0, stdout: '25A354\n', stderr: '' });
    const readings = await readProbeKeyComponents({ identity: ['binarySha256'], binary, platform: 'darwin', exec, signal: new AbortController().signal });
    expect(Object.keys(readings)).toEqual(['binarySha256']);
    expect(calls).toEqual([]);
  });

  it('reports a missing binary as unreadable, naming its path', async () => {
    const binary = path.join(systemTempRoot(), 'mm-host-absent', 'server');
    const { exec } = recordingExec({ exitCode: 0, stdout: '25A354\n', stderr: '' });
    const readings = await readProbeKeyComponents({ identity: FM_IDENTITY, binary, platform: 'darwin', exec, signal: new AbortController().signal });
    expect(readings['binarySha256']?.kind).toBe('unreadable');
    expect(readings['binarySha256']?.kind === 'unreadable' ? readings['binarySha256'].reason : '').toContain(binary);
  });

  it.each([
    ['a non-zero exit', { exitCode: 1, stdout: '', stderr: 'sw_vers: failed' }],
    ['an empty answer', { exitCode: 0, stdout: '  \n', stderr: '' }],
  ])('reports the OS build as unreadable after %s, never as a value', async (_label, answer) => {
    const binary = binaryWith('x');
    const { exec } = recordingExec(answer);
    const readings = await readProbeKeyComponents({ identity: FM_IDENTITY, binary, platform: 'darwin', exec, signal: new AbortController().signal });
    expect(readings['hostOsBuild']?.kind).toBe('unreadable');
    expect(readings['binarySha256']?.kind).toBe('read');
  });

  it('reports the OS build as unreadable on a platform with no reader, without running a command', async () => {
    const binary = binaryWith('x');
    const { calls, exec } = recordingExec({ exitCode: 0, stdout: '25A354\n', stderr: '' });
    const readings = await readProbeKeyComponents({ identity: FM_IDENTITY, binary, platform: 'linux', exec, signal: new AbortController().signal });
    expect(readings['hostOsBuild']?.kind).toBe('unreadable');
    expect(readings['hostOsBuild']?.kind === 'unreadable' ? readings['hostOsBuild'].reason : '').toContain('linux');
    expect(calls).toEqual([]);
  });
});
