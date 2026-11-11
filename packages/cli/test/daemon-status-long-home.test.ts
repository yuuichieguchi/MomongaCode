import fs from 'node:fs';
import path from 'node:path';
import type { EntryIo } from '@momonga/foundation';
import { FIRST_GENERATION, SocketPathUnsupportedError, generationLayout, momongaPaths, shortTempBase } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { describeFailure } from '../src/failure.ts';
import { nodePorts } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { firstRefusedSocketPathBytes, registerCleanup, testHostPath } from '@momonga/testkit';
import { NO_HELPER } from './no-helper.ts';

const SUPERVISOR_SOCKET_SUFFIX = Buffer.byteLength(path.join('.momonga', 'run', `g${FIRST_GENERATION}`, 'supervisor.sock')) + 1;

const homeWhoseFirstSupervisorSocketIsRefused = async (): Promise<string> => {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(shortTempBase(process.platform), 'mm-fit-')));
  const byteLength = await firstRefusedSocketPathBytes(parent);
  const home = path.join(parent, 'h'.repeat(byteLength - SUPERVISOR_SOCKET_SUFFIX - Buffer.byteLength(parent) - 1));
  fs.mkdirSync(home);
  return home;
};

describe.skipIf(process.platform === 'win32')('daemon start on a home too long for the sockets of a generation (20.19)', () => {
  it('refuses with SocketPathUnsupportedError at the start of the generation, reported as the socket path refusal: no number is consumed and no supervisor is spawned', async (context) => {
    const LONG_HOME = await homeWhoseFirstSupervisorSocketIsRefused();
    registerCleanup(context, () => fs.rmSync(path.dirname(LONG_HOME), { recursive: true, force: true }));
    const stdout: string[] = [];
    const codes: number[] = [];
    const spawned: unknown[] = [];
    const ports: CliPorts = {
      ...nodePorts('9.9.9', new AbortController().signal),
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
        helper: NO_HELPER,
        entryIo: (entryArgs) => ({ argv: [...entryArgs] }) as unknown as EntryIo,
        complete: (code) => void codes.push(code),
      },
      { embedded: true },
    );
    program.exitOverride();

    const error = await program.parseAsync(['daemon', 'start'], { from: 'user' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SocketPathUnsupportedError);
    expect(`momonga: ${describeFailure(error)}`).toMatch(/^momonga: Unix socket path .* must be shorter than/);
    expect(stdout.join('')).toBe('');
    expect(codes).toEqual([]);
    expect(spawned).toEqual([]);
    const paths = momongaPaths(LONG_HOME, process.platform, {});
    expect(fs.existsSync(paths.generationCounter)).toBe(false);
    expect(fs.existsSync(generationLayout(LONG_HOME, FIRST_GENERATION).dir)).toBe(false);
  });
});
