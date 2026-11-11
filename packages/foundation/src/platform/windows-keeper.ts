import { KEEPER_JOB_PREFIX, KEEPER_NAME_BYTES, KEEPER_PIPE_PREFIX, keeperExitName } from '../process-contract.ts';
import type { KeeperExitName } from '../process-contract.ts';
import type { Random } from '../random.ts';
import type { Timing } from '../timing.ts';

export const KEEPER_LINE_LIMIT = 1_048_576;
export const KEEPER_NO_MARKER = '-';
export const KEEPER_NO_DESCRIPTORS = '-';
export const KEEPER_DESCRIPTOR_SEPARATOR = ',';
export const KEEPER_COMMAND_SEPARATOR = '--';

export const KEEPER_FAILURE_REASONS = ['name-taken', 'containment-unavailable', 'marker-unavailable', 'launch-failed', 'job-absent'] as const satisfies readonly KeeperExitName[];

export type KeeperFailureReason = (typeof KEEPER_FAILURE_REASONS)[number];

export const KEEPER_OWNER_LOSS = ['terminate', 'persist'] as const;

export type KeeperOwnerLoss = (typeof KEEPER_OWNER_LOSS)[number];

export type KeeperMessage =
  | { kind: 'started'; pid: number; descriptors: number[] }
  | { kind: 'attached' }
  | { kind: 'failed'; reason: KeeperFailureReason; systemError: number }
  | { kind: 'exit'; code: number }
  | { kind: 'members'; id: number; pids: number[] }
  | { kind: 'empty' };

export class KeeperProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeeperProtocolError';
  }
}

export class KeeperLostError extends Error {
  readonly exitCode: number | undefined;

  constructor(exitCode: number | undefined) {
    super(exitCode === undefined ? 'the keeper closed its pipe before its first word' : `the keeper ended with ${keeperExitName(exitCode) ?? `exit code ${exitCode}`} before it connected to its pipe`);
    this.name = 'KeeperLostError';
    this.exitCode = exitCode;
  }
}

const UINT32_MAX = 0xffff_ffff;

const numberOf = (word: string | undefined, line: string): number => {
  if (word === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(word) || Number(word) > UINT32_MAX) throw new KeeperProtocolError(`the keeper sent a line with no 32-bit number where one belongs: ${JSON.stringify(line)}`);
  return Number(word);
};

const wordCount = (words: readonly string[], count: number, line: string): void => {
  if (words.length !== count) throw new KeeperProtocolError(`the keeper sent ${JSON.stringify(line)}, which is not ${count} words`);
};

const isFailureReason = (word: string | undefined): word is KeeperFailureReason => (KEEPER_FAILURE_REASONS as readonly (string | undefined)[]).includes(word);

export const parseKeeperLine = (line: string): KeeperMessage => {
  const words = line.split(' ');
  switch (words[0]) {
    case 'started':
      return { kind: 'started', pid: numberOf(words[1], line), descriptors: words.slice(2).map((word) => numberOf(word, line)) };
    case 'attached':
      wordCount(words, 1, line);
      return { kind: 'attached' };
    case 'failed': {
      wordCount(words, 3, line);
      const reason = words[1];
      if (!isFailureReason(reason)) throw new KeeperProtocolError(`the keeper failed for a reason outside the protocol: ${JSON.stringify(line)}`);
      return { kind: 'failed', reason, systemError: numberOf(words[2], line) };
    }
    case 'exit':
      wordCount(words, 2, line);
      return { kind: 'exit', code: numberOf(words[1], line) };
    case 'members':
      return { kind: 'members', id: numberOf(words[1], line), pids: words.slice(2).map((word) => numberOf(word, line)) };
    case 'empty':
      wordCount(words, 1, line);
      return { kind: 'empty' };
    default:
      throw new KeeperProtocolError(`the keeper sent a line outside the protocol: ${JSON.stringify(line.slice(0, 200))}`);
  }
};

export const createKeeperLineDecoder = (onLine: (line: string) => void): ((chunk: Uint8Array) => void) => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let held = '';
  return (chunk) => {
    held += decoder.decode(chunk, { stream: true });
    for (let end = held.indexOf('\n'); end !== -1; end = held.indexOf('\n')) {
      const line = held.slice(0, end);
      held = held.slice(end + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (held.length > KEEPER_LINE_LIMIT) throw new KeeperProtocolError(`the keeper sent more than ${KEEPER_LINE_LIMIT} characters without ending the line`);
  };
};

type NameSource = Pick<Random, 'hex'>;

export const keeperJobName = (random: NameSource): string => `${KEEPER_JOB_PREFIX}${random.hex(KEEPER_NAME_BYTES)}`;

export const keeperPipeName = (random: NameSource): string => `${KEEPER_PIPE_PREFIX}${random.hex(KEEPER_NAME_BYTES)}`;

export type KeptCommand = { readonly file: string; readonly args: readonly string[] };

export class KeptCommandRefusedError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = 'KeptCommandRefusedError';
    this.command = command;
  }
}

const COMMAND_SCRIPT = /\.(?:cmd|bat)$/i;

const INTERPRETER_CHANGES = /["\r\n%!^&|<>()]/;

const ABSOLUTE_WINDOWS_PATH = /^(?:[A-Za-z]:\\|\\\\)/;

export type KeptCommandLine = { readonly command: KeptCommand; readonly verbatim: boolean };

const quoted = (word: string): string => `"${word}"`;

export const keptCommandLineOf = (command: KeptCommand, interpreter: string): KeptCommandLine => {
  if (!ABSOLUTE_WINDOWS_PATH.test(command.file)) {
    throw new KeptCommandRefusedError(command.file, `the command ${command.file} is not an absolute path, so it was not started; give the full path of the program`);
  }
  if (!COMMAND_SCRIPT.test(command.file)) return { command, verbatim: false };
  for (const word of [command.file, ...command.args]) {
    if (INTERPRETER_CHANGES.test(word)) {
      const what = word === command.file ? `the path ${JSON.stringify(word)}` : `the argument ${JSON.stringify(word)} of ${command.file}`;
      throw new KeptCommandRefusedError(
        command.file,
        `${what} holds a character that the Windows command interpreter changes (a double quote, a line break, or one of % ! ^ & | < > ( )), so the command was not started; pass the value through an environment variable or a file`,
      );
    }
  }
  return { command: { file: quoted(interpreter), args: ['/d', '/s', '/c', quoted([command.file, ...command.args].map(quoted).join(' '))] }, verbatim: true };
};

export type KeeperLaunchWords = { pipe: string; job: string; onOwnerLoss: KeeperOwnerLoss; marker: string | undefined; descriptors: readonly number[]; command: KeptCommand };

export const keeperLaunchArguments = ({ pipe, job, onOwnerLoss, marker, descriptors, command }: KeeperLaunchWords): string[] => [
  'launch',
  pipe,
  job,
  onOwnerLoss,
  marker === undefined ? KEEPER_NO_MARKER : Buffer.from(marker, 'utf8').toString('hex'),
  descriptors.length === 0 ? KEEPER_NO_DESCRIPTORS : descriptors.join(KEEPER_DESCRIPTOR_SEPARATOR),
  KEEPER_COMMAND_SEPARATOR,
  command.file,
  ...command.args,
];

export const keeperAttachArguments = ({ pipe, job }: { pipe: string; job: string }): string[] => ['attach', pipe, job];

export type KeeperConnection = {
  write(text: string): void;
  close(): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onClosed(listener: () => void): void;
};

export type KeeperListener = {
  accept(signal: AbortSignal): Promise<KeeperConnection>;
  close(): void;
};

export type KeeperRun = { readonly exited: Promise<number | undefined> };

export type KeeperStart<P extends KeeperRun> = (executable: string, args: readonly string[], verbatim?: boolean) => P;

export type KeeperHost = {
  executable(): string;
  commandInterpreter(): string;
  listen(pipe: string): KeeperListener;
  start: KeeperStart<KeeperRun>;
  random: NameSource;
};

export type MembersAnswer = { kind: 'members'; pids: number[] } | { kind: 'closed' };

export type CommandExitAnswer = { kind: 'exit'; code: number } | { kind: 'closed' };

export type KeptGroup = {
  readonly job: string;
  members(signal: AbortSignal): Promise<MembersAnswer>;
  terminate(): void;
  ended(signal: AbortSignal): Promise<'empty' | 'closed'>;
  commandExit(signal: AbortSignal): Promise<CommandExitAnswer>;
  release(): void;
};

type FirstWord = Extract<KeeperMessage, { kind: 'started' | 'attached' | 'failed' }>;

type Session = {
  firstWord(signal: AbortSignal): Promise<FirstWord>;
  group(job: string): KeptGroup;
  close(): void;
};

const isFirstWord = (message: KeeperMessage): message is FirstWord => message.kind === 'started' || message.kind === 'attached' || message.kind === 'failed';

const createSession = (connection: KeeperConnection): Session => {
  const watchers = new Set<() => void>();
  const answers = new Map<number, number[]>();
  let first: FirstWord | undefined;
  let fault: KeeperProtocolError | undefined;
  let closed = false;
  let empty = false;
  let exitCode: number | undefined;
  let asked = 0;

  const changed = (): void => {
    for (const watcher of [...watchers]) watcher();
  };

  const until = <T>(read: () => T | undefined, signal: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const leave = (): void => {
        watchers.delete(look);
        signal.removeEventListener('abort', aborted);
      };
      const aborted = (): void => {
        leave();
        reject(signal.reason);
      };
      const look = (): void => {
        if (fault !== undefined) {
          leave();
          reject(fault);
          return;
        }
        let value: T | undefined;
        try {
          value = read();
        } catch (error) {
          leave();
          reject(error);
          return;
        }
        if (value === undefined) return;
        leave();
        resolve(value);
      };
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      watchers.add(look);
      signal.addEventListener('abort', aborted, { once: true });
      look();
    });

  const take = (message: KeeperMessage): void => {
    if (isFirstWord(message)) {
      if (first !== undefined) throw new KeeperProtocolError(`the keeper sent ${message.kind} after its first word`);
      first = message;
      return;
    }
    if (first === undefined) throw new KeeperProtocolError(`the keeper sent ${message.kind} before its first word`);
    if (message.kind === 'members') answers.set(message.id, message.pids);
    else if (message.kind === 'empty') empty = true;
    else exitCode = message.code;
  };

  const feed = createKeeperLineDecoder((line) => take(parseKeeperLine(line)));

  connection.onData((chunk) => {
    if (fault !== undefined) return;
    try {
      feed(chunk);
    } catch (error) {
      if (error instanceof KeeperProtocolError) fault = error;
      else if (error instanceof TypeError) fault = new KeeperProtocolError(`the keeper sent bytes that are not UTF-8: ${error.message}`);
      else throw error;
      connection.close();
    }
    changed();
  });
  connection.onClosed(() => {
    closed = true;
    changed();
  });

  const takeAnswer = (id: number): MembersAnswer | undefined => {
    const pids = answers.get(id);
    if (pids !== undefined) {
      answers.delete(id);
      return { kind: 'members', pids };
    }
    return closed ? { kind: 'closed' } : undefined;
  };

  return {
    firstWord: (signal) =>
      until(() => {
        if (first !== undefined) return first;
        if (closed) throw new KeeperLostError(undefined);
        return undefined;
      }, signal),
    close: () => connection.close(),
    group: (job) => ({
      job,
      members: async (signal) => {
        if (fault !== undefined) throw fault;
        if (closed) return { kind: 'closed' };
        asked += 1;
        const id = asked;
        connection.write(`members ${id}\n`);
        return until(() => takeAnswer(id), signal);
      },
      terminate: () => {
        if (!closed) connection.write('terminate\n');
      },
      ended: (signal) => until(() => (empty ? 'empty' : closed ? 'closed' : undefined), signal),
      commandExit: (signal) => until<CommandExitAnswer>(() => (exitCode !== undefined ? { kind: 'exit', code: exitCode } : closed ? { kind: 'closed' } : undefined), signal),
      release: () => connection.close(),
    }),
  };
};

type Connected = { session: Session; first: FirstWord };

type Connecting<P extends KeeperRun> = { process: P; connected: Promise<Connected> };

const connectKeeper = <P extends KeeperRun>(host: KeeperHost, wordsFor: (pipe: string) => string[], start: KeeperStart<P>, signal: AbortSignal, verbatim = false): Connecting<P> => {
  const executable = host.executable();
  const pipe = keeperPipeName(host.random);
  const listener = host.listen(pipe);
  let process: P;
  try {
    process = verbatim ? start(executable, wordsFor(pipe), true) : start(executable, wordsFor(pipe));
  } catch (error) {
    listener.close();
    throw error;
  }
  const connect = async (): Promise<Connected> => {
    let connection: KeeperConnection;
    try {
      connection = await Promise.race([
        listener.accept(signal),
        process.exited.then((code): never => {
          throw new KeeperLostError(code);
        }),
      ]);
    } finally {
      listener.close();
    }
    const session = createSession(connection);
    try {
      return { session, first: await session.firstWord(signal) };
    } catch (error) {
      session.close();
      throw error;
    }
  };
  return { process, connected: connect() };
};

export type KeptLaunchRequest<P extends KeeperRun> = {
  command: KeptCommand;
  onOwnerLoss: KeeperOwnerLoss;
  marker: string | undefined;
  descriptors: readonly number[];
  start: KeeperStart<P>;
  signal: AbortSignal;
};

export type KeptLaunch<P extends KeeperRun> =
  | { kind: 'started'; group: KeptGroup; commandPid: number; process: P }
  | { kind: 'refused'; reason: Exclude<KeeperFailureReason, 'job-absent'>; systemError: number; process: P };

export type OpenedLaunch<P extends KeeperRun> = { job: string; process: P; launched: Promise<KeptLaunch<P>> };

export const openKeptLaunch = <P extends KeeperRun>(host: KeeperHost, request: KeptLaunchRequest<P>): OpenedLaunch<P> => {
  const line = keptCommandLineOf(request.command, host.commandInterpreter());
  const job = keeperJobName(host.random);
  const { process, connected } = connectKeeper(
    host,
    (pipe) => keeperLaunchArguments({ pipe, job, onOwnerLoss: request.onOwnerLoss, marker: request.marker, descriptors: request.descriptors, command: line.command }),
    request.start,
    request.signal,
    line.verbatim,
  );
  const launched = connected.then(({ session, first }): KeptLaunch<P> => {
    if (first.kind === 'started') {
      const dropped = request.descriptors.filter((descriptor) => !first.descriptors.includes(descriptor));
      if (dropped.length === 0) return { kind: 'started', group: session.group(job), commandPid: first.pid, process };
      session.close();
      throw new KeeperProtocolError(`the keeper started command ${first.pid} without descriptor ${dropped.join(', ')}, which the launch named`);
    }
    session.close();
    if (first.kind === 'failed' && first.reason !== 'job-absent') return { kind: 'refused', reason: first.reason, systemError: first.systemError, process };
    throw new KeeperProtocolError(`a launching keeper answered ${first.kind === 'failed' ? first.reason : first.kind}`);
  });
  return { job, process, launched };
};

export const launchKept = async <P extends KeeperRun>(host: KeeperHost, request: KeptLaunchRequest<P>): Promise<KeptLaunch<P>> => openKeptLaunch(host, request).launched;

export type KeptAttach = { kind: 'attached'; group: KeptGroup } | { kind: 'absent' };

export const attachKept = async (host: KeeperHost, job: string, signal: AbortSignal): Promise<KeptAttach> => {
  const { session, first } = await connectKeeper(host, (pipe) => keeperAttachArguments({ pipe, job }), host.start, signal).connected;
  if (first.kind === 'attached') return { kind: 'attached', group: session.group(job) };
  session.close();
  if (first.kind === 'failed' && first.reason === 'job-absent') return { kind: 'absent' };
  throw new KeeperProtocolError(`an attaching keeper answered ${first.kind === 'failed' ? first.reason : first.kind}`);
};

export type NameConfirmation = 'absent' | 'present';

export type ConfirmByName = (job: string, signal: AbortSignal) => Promise<NameConfirmation>;

export const confirmByAttach =
  (host: KeeperHost): ConfirmByName =>
  async (job, signal) => {
    const attach = await attachKept(host, job, signal);
    if (attach.kind === 'absent') return 'absent';
    attach.group.release();
    return 'present';
  };

export type KeptStopOutcome = 'gone' | 'terminated' | 'unconfirmed';

export type KeptStopOptions = {
  graceMs: number;
  timing: Pick<Timing, 'setTimeout' | 'clearTimeout'>;
  signal: AbortSignal;
  confirm: ConfirmByName;
};

type Phase<T> = { kind: 'value'; value: T } | { kind: 'expired' };

const abandoned = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const leave = (): void => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', leave);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });

const withinPhase = async <T>(work: (signal: AbortSignal) => Promise<T>, { graceMs, timing, signal }: KeptStopOptions): Promise<Phase<T>> => {
  if (signal.aborted) return { kind: 'expired' };
  const phase = new AbortController();
  const expired = Symbol('expired');
  const expire = (): void => phase.abort(expired);
  const timer = timing.setTimeout(expire, graceMs);
  signal.addEventListener('abort', expire, { once: true });
  try {
    return { kind: 'value', value: await abandoned(work(phase.signal), phase.signal) };
  } catch (error) {
    if (error !== expired) throw error;
    return { kind: 'expired' };
  } finally {
    timing.clearTimeout(timer);
    signal.removeEventListener('abort', expire);
  }
};

const byName = async (group: KeptGroup, options: KeptStopOptions, signal: AbortSignal): Promise<KeptStopOutcome> => ((await options.confirm(group.job, signal)) === 'absent' ? 'gone' : 'unconfirmed');

export const stopKeptGroup = async (group: KeptGroup, options: KeptStopOptions): Promise<KeptStopOutcome> => {
  const probe = await withinPhase(async (signal): Promise<KeptStopOutcome | 'alive'> => {
    const answer = await group.members(signal);
    if (answer.kind === 'closed') return byName(group, options, signal);
    return answer.pids.length === 0 ? 'gone' : 'alive';
  }, options);
  if (probe.kind === 'expired') return 'unconfirmed';
  if (probe.value !== 'alive') return probe.value;
  group.terminate();
  const end = await withinPhase(async (signal): Promise<KeptStopOutcome> => {
    if ((await group.ended(signal)) === 'empty') return 'terminated';
    return (await byName(group, options, signal)) === 'gone' ? 'terminated' : 'unconfirmed';
  }, options);
  return end.kind === 'expired' ? 'unconfirmed' : end.value;
};
