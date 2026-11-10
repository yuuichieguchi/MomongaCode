import fs from 'node:fs';
import type { EntryIo } from '@momonga/foundation';
import { SocketPathUnsupportedError } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { describeFailure } from '../src/failure.ts';
import { nodePorts } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { testHostPath } from '@momonga/testkit';

const LONG_HOME = `/${'h'.repeat(200)}`;

describe.skipIf(process.platform === 'win32')('daemon status on a home too long for the first generation sockets', () => {
  it('refuses with SocketPathUnsupportedError, reported as the socket path refusal, before any directory is created or the daemon is reached', async () => {
    const stdout: string[] = [];
    const codes: number[] = [];
    const spawned: unknown[] = [];
    const ports: CliPorts = {
      ...nodePorts('9.9.9'),
      home: LONG_HOME,
      cwd: LONG_HOME,
      env: { PATH: testHostPath('/usr/bin:/bin'), HOME: LONG_HOME },
      terminal: undefined,
      stdout: { write: (text) => void stdout.push(text) },
      stderr: { write: () => undefined },
      spawnDetached: (spec) => {
        spawned.push(spec);
        return { exit: new Promise(() => undefined) };
      },
    };
    const entry = async (): Promise<number> => 0;
    const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
    const program = buildProgram(
      {
        ports,
        policyVerify: () => nodePolicyVerifyHost(ports, { executables: `${LONG_HOME}/cache/executables` }),
        entries,
        update: () => {
          throw new Error('the update wiring is not used by an embedded program');
        },
        interrupt: new AbortController().signal,
        entryIo: (entryArgs) => ({ argv: [...entryArgs] }) as unknown as EntryIo,
        complete: (code) => void codes.push(code),
      },
      { embedded: true },
    );
    program.exitOverride();

    const error = await program.parseAsync(['daemon', 'status'], { from: 'user' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SocketPathUnsupportedError);
    expect(`momonga: ${describeFailure(error)}`).toMatch(/^momonga: Unix socket path .* must be shorter than/);
    expect(stdout.join('')).toBe('');
    expect(codes).toEqual([]);
    expect(spawned).toEqual([]);
    expect(fs.existsSync(LONG_HOME)).toBe(false);
  });
});
