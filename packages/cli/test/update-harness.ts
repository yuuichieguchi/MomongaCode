import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_SIGNATURE_KNOWN_ANSWER, RELEASE_SIGNATURE_TOOL } from '@momonga/foundation';
import type { CommandOptions, CommandResult } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import type { DetachedSpawn, SelfExecutable } from '../src/ports.ts';
import type { UpdateWiring } from '../src/update/background.ts';
import { nodeUpdateFs, undiciUpdateHttp } from '../src/update/node-ports.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { startFakeReleaseServer } from './fake-release-server.ts';
import type { FakeReleaseServer } from './fake-release-server.ts';
import { virtualClock } from './fake-supervisor.ts';

export const REPO = 'acme/momonga';
export const TEAM_ID = 'ABCDE12345';
export const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl release@example.invalid';
export const OLD_BINARY = Buffer.from('old-binary-bytes');
export const NEW_BINARY = Buffer.from('new-binary-bytes-of-a-newer-release');

export const DAEMON_RESTART_BOUND_MS = 123_456;

export type RunCall = { file: string; args: readonly string[]; options: CommandOptions; targetContent: string; stagedContent: string | undefined };

export type SignatureCheck = { args: readonly string[]; options: CommandOptions; allowedSigners: string; signature: string; directory: string };

export type Control = {
  signature: CommandResult;
  knownAnswer: CommandResult;
  signatureToolMissing: boolean;
  codesign: CommandResult;
  reportedVersion: string | undefined;
  daemonRunning: boolean;
  daemonStart: CommandResult;
  lockHeld: boolean;
  autoUpdates: boolean;
};

export type SpawnedCheck = { spec: DetachedSpawn; reject(error: Error): void };

export type UpdateHarness = {
  dir: string;
  target: string;
  server: FakeReleaseServer;
  ports: UpdatePorts;
  wiring: UpdateWiring;
  control: Control;
  runs: RunCall[];
  signatureChecks: SignatureCheck[];
  stderr: string[];
  stdout: string[];
  spawned: SpawnedCheck[];
  released: { count: number };
  state: { value: unknown; writes: unknown[] };
  targetBytes(): Buffer;
  directoryEntries(): string[];
};

export type HarnessOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string;
  scripted?: boolean;
  build?: UpdateWiring['build'];
};

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

export const setupUpdate = async (context: TestContext, options: HarnessOptions = {}): Promise<UpdateHarness> => {
  const root = withTempDir(context);
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir);
  const target = path.join(dir, 'momonga');
  fs.writeFileSync(target, OLD_BINARY, { mode: 0o755 });
  const server = await startFakeReleaseServer(REPO);
  registerCleanup(context, () => server.stop());
  const platform = options.platform ?? 'linux';
  const control: Control = {
    signature: ok(),
    knownAnswer: ok(),
    signatureToolMissing: false,
    codesign: ok(),
    reportedVersion: undefined,
    daemonRunning: false,
    daemonStart: ok(),
    lockHeld: false,
    autoUpdates: true,
  };
  const runs: RunCall[] = [];
  const signatureChecks: SignatureCheck[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const spawned: SpawnedCheck[] = [];
  const released = { count: 0 };
  const state: UpdateHarness['state'] = { value: undefined, writes: [] };
  const self: SelfExecutable = options.scripted === true ? { kind: 'script', execPath: target, script: '/main.js' } : { kind: 'single-binary', execPath: target };
  const readText = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
  const ports: UpdatePorts = {
    version: options.version ?? '1.0.0',
    platform,
    arch: options.arch ?? (platform === 'darwin' ? 'arm64' : 'x64'),
    home: root,
    self,
    env: { PATH: '/usr/bin' },
    clock: virtualClock(),
    http: undiciUpdateHttp(),
    fs: nodeUpdateFs(),
    run: async (file, args, options) => {
      if (file === RELEASE_SIGNATURE_TOOL) {
        if (control.signatureToolMissing) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
        if (options.input === RELEASE_SIGNATURE_KNOWN_ANSWER.content) return control.knownAnswer;
        const placed = (flag: string): string => readText(args[args.indexOf(flag) + 1] as string) as string;
        signatureChecks.push({ args, options, allowedSigners: placed('-f'), signature: placed('-s'), directory: path.dirname(args[args.indexOf('-f') + 1] as string) });
        return control.signature;
      }
      runs.push({ file, args, options, targetContent: fs.readFileSync(target, 'utf8'), stagedContent: readText(file) });
      if (file === '/usr/bin/codesign') return control.codesign;
      if (args[0] === '--version') return ok(`${control.reportedVersion ?? (server.latestTag ?? '').slice(1)}\n`);
      if (args[0] === 'daemon' && args[1] === 'start') return control.daemonStart;
      throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    },
    lock: {
      isHeld: async () => control.lockHeld,
      acquire: async () => {
        if (control.lockHeld) return undefined;
        return {
          release: () => {
            released.count += 1;
          },
        };
      },
    },
    state: {
      read: async () => state.value,
      write: async (value) => {
        state.value = value;
        state.writes.push(value);
      },
    },
    daemon: { running: async () => control.daemonRunning, restartBoundMs: async () => DAEMON_RESTART_BOUND_MS },
    autoUpdates: async () => control.autoUpdates,
    spawnDetached: (spec) => {
      let rejectExit: (error: Error) => void = () => undefined;
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_resolve, reject) => {
        rejectExit = reject;
      });
      spawned.push({ spec, reject: rejectExit });
      return { exit };
    },
    stderr: { write: (text) => void stderr.push(text) },
  };
  const wiring: UpdateWiring = {
    ports,
    build: options.build ?? { repo: REPO, teamId: TEAM_ID, publicKey: PUBLIC_KEY },
    endpoints: server.endpoints,
    checkIntervalMs: 1000,
  };
  return {
    dir,
    target,
    server,
    ports,
    wiring,
    control,
    runs,
    signatureChecks,
    stderr,
    stdout,
    spawned,
    released,
    state,
    targetBytes: () => fs.readFileSync(target),
    directoryEntries: () => fs.readdirSync(dir).sort(),
  };
};
