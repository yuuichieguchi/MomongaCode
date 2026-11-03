import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { terminalPorts, terminalSink } from '../src/terminal-writer.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';

const HOSTILE = 'x\u001b]0;pwn\u0007\u009b2J‮y';
const ESCAPED = 'x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey';
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u;

describe('the terminal writer', () => {
  it('escapes control characters and bidirectional controls, and keeps newline and tab', () => {
    const written: string[] = [];
    terminalSink(() => ({ write: (text) => void written.push(text) })).write(`a\n\tb ${HOSTILE}`);
    expect(written).toEqual([`a\n\tb ${ESCAPED}`]);
  });

  it('leaves text it already escaped as it is', () => {
    const written: string[] = [];
    const sink = terminalSink(() => ({ write: (text) => void written.push(text) }));
    sink.write(HOSTILE);
    sink.write(written[0] ?? '');
    expect(written[1]).toBe(ESCAPED);
  });

  it('wraps stdout and stderr of the ports, and reads the streams only when it writes', () => {
    const out: string[] = [];
    const err: string[] = [];
    const raw = {} as CliPorts;
    const ports = terminalPorts(raw);
    Object.assign(raw, { stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) } });
    ports.stdout.write(HOSTILE);
    ports.stderr.write(HOSTILE);
    expect([out, err]).toEqual([[ESCAPED], [ESCAPED]]);
  });
});

describe('the program hands its commands only the terminal writer', () => {
  const harness = () => {
    const out: string[] = [];
    const err: string[] = [];
    const entry = async (): Promise<number> => 0;
    const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
    const ports = { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined, stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) } } as unknown as CliPorts;
    const program = buildProgram({
      ports,
      policyVerify: () => nodePolicyVerifyHost(ports, { cacheBase: '/c/cache' }),
      entries,
      update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
      interrupt: new AbortController().signal,
      entryIo: (args) => ({ name: 'io', argv: [...args] }) as unknown as EntryIo,
      complete: () => undefined,
    });
    program.exitOverride();
    for (const command of program.commands) command.exitOverride();
    return { program, out, err };
  };

  it('escapes the usage error that commander prints about an argument the user typed', async () => {
    const { program, err } = harness();
    await program.parseAsync([`--${HOSTILE}`], { from: 'user' }).catch(() => undefined);
    expect(err.join('')).not.toMatch(UNSAFE);
    expect(err.join('')).toContain(ESCAPED);
  });

  it('escapes the usage error of a subcommand', async () => {
    const { program, err } = harness();
    await program.parseAsync(['memory', `--${HOSTILE}`], { from: 'user' }).catch(() => undefined);
    expect(err.join('')).not.toMatch(UNSAFE);
    expect(err.join('')).toContain(ESCAPED);
  });
});
