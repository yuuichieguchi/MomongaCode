import fs from 'node:fs';
import path from 'node:path';
import { GIT_APPROVED_SUBCOMMANDS } from '@momonga/policy';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { testKernelLock } from '@momonga/testkit';

export const KILL_GRACE_MS = 300;
export const REFUSED_WRITE_MESSAGE = process.platform === 'darwin' ? 'Operation not permitted' : 'Read-only file system';
export const HAS_REAL_SANDBOX = process.platform === 'darwin' || process.platform === 'linux';

export const realSandbox = (tmpRoot: string): Sandbox => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  if (process.platform === 'darwin') return createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot, killGraceMs: KILL_GRACE_MS });
  if (!fs.existsSync(DEFAULT_BWRAP_PATH)) throw new Error(`the read-only matrix needs real bwrap at ${DEFAULT_BWRAP_PATH}`);
  return createBubblewrapSandbox({ lock: testKernelLock(), tmpRoot, killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(`${tmpRoot}-journal`), holders: () => heldMountPoints() });
};

export type RecordedSpawn = { command: SandboxCommand; policy: SandboxPolicy };

export const recordingSandbox = (inner: Sandbox): { sandbox: Sandbox; spawns: RecordedSpawn[] } => {
  const spawns: RecordedSpawn[] = [];
  return {
    spawns,
    sandbox: {
      kind: inner.kind,
      spawn: (command, policy, signal, descriptors) => {
        spawns.push({ command, policy });
        return inner.spawn(command, policy, signal, descriptors);
      },
    },
  };
};

const REFUSED_XCRUN_CACHE_WRITE = /^[A-Za-z][A-Za-z0-9._+-]*: error: couldn't create cache file '[^'\n]*\/xcrun_db-[A-Za-z0-9]{8}' \(errno=Operation not permitted\)\n/gm;

export const withoutRefusedXcrunCacheWrite = (stderr: string, platform: NodeJS.Platform): string =>
  platform === 'darwin' ? stderr.replace(REFUSED_XCRUN_CACHE_WRITE, '') : stderr;

export const scratchRootOf = (layoutRoot: string): string => path.join(layoutRoot, 'recording-tmp');

export const REQUIRED_GIT_KEYS: readonly string[] = [
  'core.fsmonitor',
  'core.hooksPath',
  'core.pager',
  'core.editor',
  'core.sshCommand',
  'core.askPass',
  'core.gitProxy',
  'core.alternateRefsCommand',
  'gpg.program',
  'gpg.ssh.program',
  'gpg.x509.program',
  'gpg.ssh.defaultKeyCommand',
  'credential.helper',
  'sequence.editor',
  'interactive.diffFilter',
  'uploadpack.packObjectsHook',
  'protocol.allow',
  'protocol.ext.allow',
  'protocol.file.allow',
  'protocol.git.allow',
  'protocol.http.allow',
  'protocol.https.allow',
  'protocol.ssh.allow',
  'protocol.ftp.allow',
  'protocol.ftps.allow',
  ...GIT_APPROVED_SUBCOMMANDS.map((subcommand) => `pager.${subcommand}`),
];

export const CLEARED_GIT_VARIABLES: readonly string[] = [
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXTERNAL_DIFF',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PROXY_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_MAN_VIEWER',
  'GIT_ALLOW_PROTOCOL',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
];

export const configuredKeys = (env: Readonly<Record<string, string | undefined>>): string[] => {
  const count = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  return Array.from({ length: count }, (_, index) => env[`GIT_CONFIG_KEY_${index}`] ?? '');
};
