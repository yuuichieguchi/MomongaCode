import { KEEPER_JOB_PREFIX, KEEPER_NAME_FORM } from '../process-contract.ts';
import type { GroupProbeOptions } from './group-port.ts';
import { hostKeeperHost } from './windows-keeper-host.ts';
import { KeeperLostError, attachKept, openKeptLaunch } from './windows-keeper.ts';
import type { KeeperFailureReason, KeeperHost, KeeperRun, KeptCommand, KeptGroup } from './windows-keeper.ts';

export type KeptProcess = KeeperRun & { readonly pid: number | undefined };

export type KeptOpenRequest<P extends KeptProcess> = {
  command: KeptCommand;
  marker: string | undefined;
  descriptors: readonly number[];
  start(executable: string, args: readonly string[]): P;
};

export type KeptExit = { kind: 'exit'; code: number } | { kind: 'lost' };

export type KeptOpening<P extends KeptProcess> = { process: P; commandPid: Promise<number>; commandExit: Promise<KeptExit> };

export class GroupContainmentError extends Error {
  readonly reason: KeeperFailureReason;
  readonly systemError: number;

  constructor(reason: KeeperFailureReason, systemError: number) {
    super(`the command was not started: its processes could not be held in a Job Object (${reason}, Windows error ${systemError})`);
    this.name = 'GroupContainmentError';
    this.reason = reason;
    this.systemError = systemError;
  }
}

export type KeptGroupControl = {
  open<P extends KeptProcess>(request: KeptOpenRequest<P>): KeptOpening<P>;
  nameOf(pgid: number): string | undefined;
  recall(pgid: number, name: string): void;
  leads(pgid: number): boolean;
  members(pgid: number, options: GroupProbeOptions): Promise<KeptMembers>;
  terminate(pgid: number, options: GroupProbeOptions): Promise<void>;
  ended(pgid: number, options: GroupProbeOptions): Promise<void>;
};

export type KeptMembers = { kind: 'members'; pids: number[] } | { kind: 'unknown' };

type Entry = { job: string; live: Promise<KeptGroup | undefined> | undefined; gone: boolean };

const within = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
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

export const createKeptGroupControl = (host: KeeperHost): KeptGroupControl => {
  const entries = new Map<number, Entry>();
  const unbounded = new AbortController().signal;

  const ended = (pgid: number, entry: Entry): void => {
    entry.gone = true;
    if (entries.get(pgid) === entry) entries.delete(pgid);
  };

  const liveOf = async (entry: Entry, signal: AbortSignal): Promise<KeptGroup | undefined> => (entry.live === undefined ? undefined : within(entry.live, signal));

  const byName = async <T>(pgid: number, entry: Entry, signal: AbortSignal, absent: T, use: (group: KeptGroup) => Promise<T>): Promise<T> => {
    const attach = await attachKept(host, entry.job, signal);
    if (attach.kind === 'absent') {
      ended(pgid, entry);
      return absent;
    }
    try {
      return await use(attach.group);
    } finally {
      attach.group.release();
    }
  };

  const listed = async (group: KeptGroup, signal: AbortSignal): Promise<number[] | undefined> => {
    const answer = await group.members(signal);
    return answer.kind === 'members' ? answer.pids : undefined;
  };

  const emptied = async (pgid: number, entry: Entry, live: KeptGroup, signal: AbortSignal): Promise<boolean> => {
    if ((await live.ended(signal)) !== 'empty') return false;
    ended(pgid, entry);
    return true;
  };

  const membersByName = (pgid: number, entry: Entry, signal: AbortSignal): Promise<number[]> =>
    byName(pgid, entry, signal, [], async (group) => {
      const pids = await listed(group, signal);
      if (pids === undefined) throw new Error(`the keeper attached to ${entry.job} closed its pipe before it listed the members`);
      return pids;
    });

  return {
    open: <P extends KeptProcess>({ command, marker, descriptors, start }: KeptOpenRequest<P>): KeptOpening<P> => {
      const lifetime = new AbortController();
      const opened = openKeptLaunch(host, { command, onOwnerLoss: 'terminate', marker, descriptors, start, signal: lifetime.signal });
      const entry: Entry = { job: opened.job, live: undefined, gone: false };
      const launchedCommand = opened.launched.then((launch) => {
        if (launch.kind === 'refused') throw new GroupContainmentError(launch.reason, launch.systemError);
        return launch;
      });
      const started = launchedCommand.then((launch) => launch.group);
      const { pid } = opened.process;
      const endEntry = (): void => {
        if (pid === undefined) entry.gone = true;
        else ended(pid, entry);
      };
      entry.live = started.then(
        (group) => group,
        (error: unknown) => {
          if (error instanceof GroupContainmentError || error instanceof KeeperLostError) endEntry();
          return undefined;
        },
      );
      started
        .then((group) => group.ended(lifetime.signal))
        .then(
          (end) => {
            if (end === 'empty') endEntry();
          },
          () => undefined,
        );
      if (pid !== undefined) entries.set(pid, entry);
      const commandPid = launchedCommand.then((launch) => launch.commandPid);
      const commandExit = commandPid.then(() => started).then((group) => group.commandExit(lifetime.signal)).then((answer): KeptExit => (answer.kind === 'exit' ? answer : { kind: 'lost' }));
      return { process: opened.process, commandPid, commandExit };
    },
    nameOf: (pgid) => entries.get(pgid)?.job.slice(KEEPER_JOB_PREFIX.length),
    recall: (pgid, name) => {
      if (!KEEPER_NAME_FORM.test(name)) throw new RangeError(`${JSON.stringify(name)} is not the name of a job of the keeper`);
      const job = `${KEEPER_JOB_PREFIX}${name}`;
      const known = entries.get(pgid);
      if (known !== undefined && (known.job === job || known.live !== undefined)) return;
      entries.set(pgid, { job, live: undefined, gone: false });
    },
    leads: (pgid) => {
      const entry = entries.get(pgid);
      return entry !== undefined && entry.live !== undefined && !entry.gone;
    },
    members: async (pgid, options) => {
      const entry = entries.get(pgid);
      if (entry === undefined) return { kind: 'unknown' };
      const signal = options.signal ?? unbounded;
      const none: KeptMembers = { kind: 'members', pids: [] };
      if (entry.gone) return none;
      const live = await liveOf(entry, signal);
      if (live !== undefined) {
        const pids = await listed(live, signal);
        if (pids !== undefined) return { kind: 'members', pids };
        if (await emptied(pgid, entry, live, signal)) return none;
      }
      if (entry.gone) return none;
      return { kind: 'members', pids: await membersByName(pgid, entry, signal) };
    },
    terminate: async (pgid, options) => {
      const entry = entries.get(pgid);
      if (entry === undefined || entry.gone) return;
      const signal = options.signal ?? unbounded;
      const live = await liveOf(entry, signal);
      if (live !== undefined) {
        if ((await listed(live, signal)) !== undefined) {
          live.terminate();
          return;
        }
        if (await emptied(pgid, entry, live, signal)) return;
      }
      if (entry.gone) return;
      await byName(pgid, entry, signal, undefined, async (group) => {
        group.terminate();
        await group.ended(signal);
      });
    },
    ended: async (pgid, options) => {
      const entry = entries.get(pgid);
      if (entry === undefined || entry.gone) return;
      const signal = options.signal ?? unbounded;
      const live = await liveOf(entry, signal);
      if (live !== undefined) {
        await emptied(pgid, entry, live, signal);
        return;
      }
      if (entry.gone) return;
      await byName(pgid, entry, signal, undefined, async (group) => {
        await group.ended(signal);
      });
    },
  };
};

let hostControl: KeptGroupControl | undefined;

export const hostKeptGroups = (): KeptGroupControl => {
  hostControl ??= createKeptGroupControl(hostKeeperHost());
  return hostControl;
};
