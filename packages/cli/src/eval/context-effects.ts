import fs from 'node:fs/promises';
import path from 'node:path';
import { applyWorkspaceStep } from '@momonga/eval';
import { STARTUP_TIMEOUT_MS, createBinaryHashCache, createHostExec, createOwnedDirectory, currentGenerationLock, ensureMomongaDirs, hostKernelLock, inspectProcessLock, isProcessAlive, shortTempBase } from '@momonga/foundation';
import type { KernelLockMechanism, OwnedDirectory } from '@momonga/foundation';
import { loadUserModels, registeredServer } from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import { DAEMON_POLL_INTERVAL_MS } from '../constants.ts';
import { STOP_WAIT_WHEN_UNKNOWN_MS, ensureDaemon } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import { pathsOf } from '../paths.ts';
import { OWNER_FILE, ROOT_PREFIX, caseEnvironment, isLegacyOwnerMarker, parseEvalOwner } from './context-host.ts';
import type { ContextHostEffects, EvalOwner, ManagedRecordSource } from './context-host.ts';

export const MAX_TIMER_MS = 2_147_483_647;

const KILL_WAIT_MS = 5_000;

const isMissingProcess = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ESRCH';

const signalProcess = (pid: number, signal: NodeJS.Signals, group: boolean): void => {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
};

const gone = async (ports: Pick<CliPorts, 'clock'>, pid: number, boundMs: number): Promise<boolean> => {
  const until = ports.clock.now() + boundMs;
  while (isProcessAlive(pid)) {
    if (ports.clock.now() >= until) return false;
    await ports.clock.sleep(DAEMON_POLL_INTERVAL_MS);
  }
  return true;
};

const PRIVATE_DIRECTORY_MODE = 0o700;

export const copyProbeRecord = async (files: Pick<CliPorts['files'], 'readTextIfPresent' | 'writeText'>, from: string, to: string, source: ManagedRecordSource, servers: ServerRegistry, signal: AbortSignal): Promise<boolean> => {
  const { managedKeyReader, managedRecordPath } = await import('@momonga/gateway');
  const description = registeredServer(servers, source.server);
  if (description === undefined) throw new Error(`the target ${source.target} names the server ${source.server}, which the loaded settings do not declare`);
  const exec = createHostExec();
  const key = await managedKeyReader({ description, binary: source.binary, model: source.model, exec, platform: process.platform, hashes: createBinaryHashCache() })(signal);
  if (key.kind === 'unknown') return false;
  const text = await files.readTextIfPresent(managedRecordPath(from, key));
  if (text === undefined) return false;
  await fs.mkdir(to, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await files.writeText(managedRecordPath(to, key), text);
  return true;
};

export const copyEndpointProbeRecord = async (
  files: Pick<CliPorts['files'], 'readTextIfPresent' | 'writeText'>,
  from: string,
  to: string,
  key: { endpoint: string; model: string },
): Promise<boolean> => {
  const { endpointRecordFileName } = await import('@momonga/gateway');
  const name = endpointRecordFileName(key);
  const text = await files.readTextIfPresent(path.join(from, name));
  if (text === undefined) return false;
  await fs.mkdir(to, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await files.writeText(path.join(to, name), text);
  return true;
};

const UNREADABLE_CODES: ReadonlySet<string | undefined> = new Set(['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']);

const VANISHED_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR']);

export const readEvalOwner = async (files: Pick<CliPorts['files'], 'readTextIfPresent'>, root: string): Promise<EvalOwner | 'legacy' | 'unreadable' | undefined> => {
  try {
    const text = await files.readTextIfPresent(path.join(root, OWNER_FILE));
    if (text === undefined) return undefined;
    return isLegacyOwnerMarker(text) ? 'legacy' : parseEvalOwner(text);
  } catch (error) {
    if (UNREADABLE_CODES.has((error as NodeJS.ErrnoException).code)) return 'unreadable';
    throw error;
  }
};

export const listEvalRoots = async (base: string, uid: number | undefined): Promise<string[]> => {
  const roots: string[] = [];
  for (const name of await fs.readdir(base)) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const entry = path.join(base, name);
    try {
      const stat = await fs.lstat(entry);
      if (stat.isDirectory() && (uid === undefined || stat.uid === uid)) roots.push(entry);
    } catch (error) {
      if (!VANISHED_CODES.has((error as NodeJS.ErrnoException).code)) throw error;
    }
  }
  return roots;
};

type OwnedRoots = { make(): Promise<string>; remove(directory: string): Promise<void> };

const ownedRoots = (ports: CliPorts, lock: KernelLockMechanism): OwnedRoots => {
  const owned = new Map<string, OwnedDirectory>();
  return {
    make: async () => {
      const root = await createOwnedDirectory({ parent: shortTempBase(ports.platform), prefix: ROOT_PREFIX, lock });
      owned.set(root.path, root);
      return root.path;
    },
    remove: async (directory) => {
      const root = owned.get(directory);
      owned.delete(directory);
      if (root === undefined) await ports.files.rm(directory, { recursive: true });
      else await root.dispose();
    },
  };
};

export const nodeContextEffects = (ports: CliPorts, lock: KernelLockMechanism = hostKernelLock()): ContextHostEffects => {
  const roots = ownedRoots(ports, lock);
  return {
    lock,
    platform: ports.platform,
    env: ports.env,
    ownerPid: process.pid,
    ownerHome: ports.home,
    readSecret: (name, signal) => ports.secretStore().read(name, signal),
    copyEndpointProbeRecord: async (probe, paths) => {
      await copyEndpointProbeRecord(ports.files, (await pathsOf(ports)).probe, paths.probe, probe);
    },
    copyProbeRecord: async (source, paths) => void (await copyProbeRecord(ports.files, (await pathsOf(ports)).probe, paths.probe, source, loadUserModels({ home: ports.home }).resolved.servers, AbortSignal.timeout(STARTUP_TIMEOUT_MS))),
    listRoots: () => listEvalRoots(shortTempBase(ports.platform), ports.platform === 'win32' ? undefined : process.getuid?.()),
    readOwner: (root) => readEvalOwner(ports.files, root),
    sessionEnv: (root) => environmentSnapshot({ home: ports.home, env: caseEnvironment(ports.env, root, ports.platform) }),
    makeRoot: () => roots.make(),
    prepare: (paths) => ensureMomongaDirs(paths),
    writeFile: async (file, text) => {
      await ports.files.mkdir(path.dirname(file));
      await ports.files.writeText(file, text);
    },
    makeDirectory: (directory) => ports.files.mkdir(directory),
    canonical: (directory) => fs.realpath(directory),
    startDaemon: async (root, paths, env) => (await ensureDaemon({ ...ports, home: root, env }, paths, { lifeline: true, onNotice: stderrStopNotice(ports) })).pid,
    daemonHolder: async (paths) => {
      const lock = await inspectProcessLock(await currentGenerationLock(paths, 'supervisor'));
      return lock.state === 'held' ? lock.pid : undefined;
    },
    terminate: async (pid) => {
      signalProcess(pid, 'SIGTERM', false);
      if (await gone(ports, pid, STOP_WAIT_WHEN_UNKNOWN_MS)) return;
      signalProcess(pid, 'SIGKILL', true);
      signalProcess(pid, 'SIGKILL', false);
      if (!(await gone(ports, pid, KILL_WAIT_MS))) throw new Error(`the daemon with pid ${pid} did not stop after SIGTERM and SIGKILL`);
    },
    remove: (directory) => roots.remove(directory),
    connect: (paths) => connectRuntime(paths),
    applyStep: (cwd, step) => applyWorkspaceStep(cwd, step),
    now: () => ports.clock.now(),
    after: (milliseconds, signal) =>
      new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer =
          milliseconds > MAX_TIMER_MS
            ? undefined
            : setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
              }, milliseconds);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
};
