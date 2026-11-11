import type { EntryIo } from '@momonga/foundation';
import type { KeptWork } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { freshHome } from '../fresh-home.ts';
import type { DaemonEntries } from '../../src/daemon/entries.ts';
import { handoverFailedText, restoreRefusedText } from '../../src/handover/texts.ts';
import type { CliPorts } from '../../src/ports.ts';
import { buildProgram, reopenOf } from '../../src/program.ts';
import type { UpdatePorts } from '../../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../../src/update/source.ts';
import { NO_HELPER } from '../no-helper.ts';

class Parsed extends Error {
  readonly command: string;
  readonly operands: readonly string[];
  readonly options: Record<string, unknown>;
  constructor(command: string, operands: readonly string[], options: Record<string, unknown>) {
    super('parsed');
    this.command = command;
    this.operands = operands;
    this.options = options;
  }
}

const programOf = () => {
  const ports = { version: '9.9.9', interrupt: new AbortController().signal, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, terminal: undefined } as unknown as CliPorts;
  const refuse = async (): Promise<number> => {
    throw new Error('the test starts no daemon entry');
  };
  const entries: DaemonEntries = { supervise: refuse, gateway: refuse, runtime: refuse };
  const program = buildProgram({
    ports,
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  program.exitOverride();
  program.hook('preAction', (_root, action) => {
    throw new Parsed(action === program ? '' : action.name(), action.args, action.opts());
  });
  return program;
};

const parse = async (command: string): Promise<Parsed> => {
  const [name, ...args] = command.split(' ');
  expect(name).toBe('momonga');
  const parsed: unknown = await programOf().parseAsync(args, { from: 'user' }).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(parsed instanceof Parsed)) throw new Error(`the program did not parse ${command}`);
  return parsed;
};

const commandsIn = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');

const FAILURE = { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'the record could not be written' };

const textsOf = (kept: KeptWork): string[] => [handoverFailedText('cli', { ...FAILURE, kept }), restoreRefusedText({ reason: FAILURE.reason, kept })];

describe('a command printed as a remedy is one the program parses for the id it names', () => {
  it('a kept session is reopened by a command the program parses as a resume of that session', async () => {
    for (const text of textsOf({ kind: 'sessions', sessionIds: ['0123456789abcdef', 'fedcba9876543210'] })) {
      const parsed = await Promise.all(commandsIn(text).map(parse));
      expect(parsed.map((each) => ({ command: each.command, reopen: reopenOf(each.options) }))).toEqual([
        { command: '', reopen: { kind: 'id', id: '0123456789abcdef' } },
        { command: '', reopen: { kind: 'id', id: 'fedcba9876543210' } },
      ]);
    }
  });

  it('a kept run is opened by the attach command with that run', async () => {
    for (const text of textsOf({ kind: 'run', runId: 'run-1' })) {
      const parsed = await Promise.all(commandsIn(text).map(parse));
      expect(parsed.map((each) => ({ command: each.command, operands: each.operands }))).toEqual([{ command: 'attach', operands: ['run-1'] }]);
    }
  });

  it('work that names no session is reopened by the resume that lets the person pick', async () => {
    for (const text of textsOf({ kind: 'unnamed' })) {
      const parsed = await Promise.all(commandsIn(text).map(parse));
      expect(parsed.map((each) => reopenOf(each.options))).toEqual([{ kind: 'pick' }]);
    }
  });
});
