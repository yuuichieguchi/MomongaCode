import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { createMover } from '../src/handover/mover.ts';
import type { MoveSurface } from '../src/handover/mover.ts';
import { HANDOVER_FORMAT } from '../src/handover/record.ts';
import type { AcpRecord, HandoverRecord, StreamRecord, TuiRecord } from '../src/handover/record.ts';
import { adoptionOf, refuseStart } from '../src/handover/start.ts';
import { streamSurface } from '../src/handover/stream.ts';
import { handoverFailedText, keptWorkOf, restoreRefusedText, surfaceOfRecord } from '../src/handover/texts.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram, reopenOf } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';

const COMMON = { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4' } as const;

const TUI: TuiRecord = {
  ...COMMON,
  kind: 'tui',
  session: 'session-7',
  lastSeq: {},
  neg: { kitty: 'unknown', modifyOtherKeys: 'unknown' } as unknown as TuiRecord['neg'],
  hint: 'none' as unknown as TuiRecord['hint'],
  size: { columns: 80, rows: 24 },
  input: { text: '', cursor: 0, historyIndex: null },
  attachments: [],
  notes: [],
};

const ATTACH: StreamRecord = { ...COMMON, kind: 'attach', session: 'session-7', lastSeq: { 'run-9': 4 }, runId: 'run-9', output: 'text', verbose: false };

const HEADLESS: StreamRecord = { ...ATTACH, kind: 'headless' };

const ACP: AcpRecord = { ...COMMON, kind: 'acp', session: 'acp-1731300000000', lastSeq: {}, initialize: {}, sessions: ['session-a', 'session-b'], input: '' };

const program = () => {
  const sink = { write: (): boolean => true };
  const entry = async (): Promise<number> => 0;
  return buildProgram({
    ports: { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined, stdout: sink, stderr: sink } as unknown as CliPorts,
    policyVerify: () => {
      throw new Error('policy verify is not part of this test');
    },
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

type Accepted = { by: 'root'; reopen: ReturnType<typeof reopenOf> } | { by: string; argument: string; value: string };

const acceptedBy = (commandLine: string): Accepted => {
  const [name, ...words] = commandLine.split(' ');
  const root = program();
  if (name !== root.name()) throw new Error(`${commandLine} does not start with the name of the program`);
  const { operands, unknown } = root.parseOptions(words);
  const [first, ...own] = operands;
  if (first === undefined) {
    if (unknown.length > 0) throw new Error(`${commandLine} holds options the program does not know: ${unknown.join(' ')}`);
    return { by: 'root', reopen: reopenOf(root.opts()) };
  }
  const command = root.commands.find((candidate) => candidate.name() === first);
  if (command === undefined) throw new Error(`${commandLine} names no command of the program`);
  const given = command.parseOptions([...own, ...unknown]);
  if (given.unknown.length > 0) throw new Error(`${commandLine} holds options ${first} does not know: ${given.unknown.join(' ')}`);
  const [value, ...extra] = given.operands;
  const [argument] = command.registeredArguments;
  if (value === undefined || argument === undefined || extra.length > 0) throw new Error(`${commandLine} does not give ${first} the one argument it takes`);
  return { by: first, argument: argument.name(), value };
};

const commandsIn = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(([, command]) => command ?? '');

const failedTextOf = (record: HandoverRecord): string => handoverFailedText(surfaceOfRecord(record), { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'disk full', kept: keptWorkOf(record) });

describe('the remedy a handover prints is accepted by the command it names (cli-commands-C15)', () => {
  it('an interactive session is reopened by its session id', () => {
    expect(commandsIn(failedTextOf(TUI)).map(acceptedBy)).toEqual([{ by: 'root', reopen: { kind: 'id', id: 'session-7' } }]);
  });

  it.each([ATTACH, HEADLESS])('a stream of the kind $kind is attached by its run id, which is what attach takes', (record) => {
    expect(commandsIn(failedTextOf(record)).map(acceptedBy)).toEqual([{ by: 'attach', argument: 'run-id', value: 'run-9' }]);
  });

  it('an ACP connection names each session it holds, and never the name of its record', () => {
    const text = failedTextOf(ACP);
    expect(text).not.toContain(ACP.session);
    expect(commandsIn(text).map(acceptedBy)).toEqual([
      { by: 'root', reopen: { kind: 'id', id: 'session-a' } },
      { by: 'root', reopen: { kind: 'id', id: 'session-b' } },
    ]);
  });

  it('a record that cannot be read leads to the list of sessions, and a record of another kind to what it holds', () => {
    const unread = adoptionOf({ file: '/h/run/handover/acp-1731300000000.json', session: 'acp-1731300000000', parsed: { kind: 'refused', reason: 'the record is not JSON' }, terminal: undefined }, ['acp']);
    if (unread.kind !== 'refused') throw new Error('the unreadable record was not refused');
    expect(commandsIn(restoreRefusedText(unread)).map(acceptedBy)).toEqual([{ by: 'root', reopen: { kind: 'pick' } }]);
    const other = adoptionOf({ file: '/h/run/handover/session-7.json', session: 'session-7', parsed: { kind: 'record', record: ATTACH }, terminal: undefined }, ['tui']);
    if (other.kind !== 'refused') throw new Error('the record of another kind was not refused');
    expect(commandsIn(restoreRefusedText(other)).map(acceptedBy)).toEqual([{ by: 'attach', argument: 'run-id', value: 'run-9' }]);
  });

  it('the refusal printed at a start carries the same remedy', () => {
    const written: string[] = [];
    refuseStart({ stderr: { write: (text: string) => void written.push(text) } }, { reason: 'the record is not JSON', kept: { kind: 'unnamed' }, terminal: undefined });
    expect(written.flatMap(commandsIn).map(acceptedBy)).toEqual([{ by: 'root', reopen: { kind: 'pick' } }]);
  });
});

describe('a move that stays tells the remedy of the surface that stays', () => {
  const stayedTextOf = async (surface: Pick<MoveSurface, 'surface' | 'kept' | 'snapshot'>, file: string): Promise<string> => {
    const said: string[] = [];
    const mover = createMover({
      version: '1.2.3',
      parties: async () => ({ writer: 1, reader: 1, namespace: 'single' }),
      write: () => undefined,
      remove: () => undefined,
      handOver: () => undefined,
      target: (recordFile) => ({ file: '/opt/momonga', args: ['--handover', recordFile], env: {} }),
      replace: () => Promise.reject(new Error('the mover replaced a process it refused to move')),
    });
    mover.attach({ ...surface, recordFile: () => file, quiet: () => true, terminal: () => undefined, suspend: () => Promise.resolve(), release: () => undefined, resume: () => undefined, say: (text) => void said.push(text) });
    mover.refuse('1.2.4', 'the installed program is still v1.2.3');
    await mover.learned('1.2.4');
    const [text] = said;
    if (text === undefined || said.length !== 1) throw new Error(`the mover said ${said.length} texts`);
    return text;
  };

  it('a stream names attach with the run id of the stream, not the session its record file is named by', async () => {
    const surface = streamSurface({
      move: { mover: { attach: () => () => undefined, check: () => Promise.resolve() }, kind: 'attach', recordFile: (session) => `/h/run/handover/${session}.json` },
      version: '1.2.3',
      runId: 'run-9',
      format: 'text',
      verbose: false,
      session: () => 'session-7',
      cursor: () => 4,
      pending: () => 0,
      say: () => undefined,
    });
    const text = await stayedTextOf(surface, '/h/run/handover/session-7.json');
    expect(text).not.toContain('session-7');
    expect(commandsIn(text).map(acceptedBy)).toEqual([{ by: 'attach', argument: 'run-id', value: 'run-9' }]);
  });

  it('an ACP surface names its sessions, not the name of its record', async () => {
    const text = await stayedTextOf({ surface: 'acp', kept: () => keptWorkOf(ACP), snapshot: () => ACP }, '/h/run/handover/acp-1731300000000.json');
    expect(text).not.toContain('acp-1731300000000');
    expect(commandsIn(text).map(acceptedBy)).toEqual([
      { by: 'root', reopen: { kind: 'id', id: 'session-a' } },
      { by: 'root', reopen: { kind: 'id', id: 'session-b' } },
    ]);
  });
});
