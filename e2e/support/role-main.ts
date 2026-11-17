import fs from 'node:fs';
import path from 'node:path';
import { nodeEntryIo, nodeFileSystem } from '@momonga/foundation';
import { fileSystemWithFault } from '@momonga/testkit/file-system-fault';
import type { FileSystem } from '@momonga/foundation';
import { runGatewayEntry } from '@momonga/gateway';
import { runRuntimeEntry } from '@momonga/runtime';

const PRODUCT_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'packages', 'cli', 'src', 'main.ts');

export const FILE_FAULT_FLAG = '--role-main-file-fault=';

export type RoleMainFileFault = { readonly code: string; readonly under: string; readonly marker: string; readonly record: string };

export const fileFaultArgument = (fault: RoleMainFileFault): string => `${FILE_FAULT_FLAG}${JSON.stringify(fault)}`;

export const RETENTION_CRASH_FLAG = '--role-main-retention-crash=';

export type RoleMainRetentionCrash = { readonly marker: string; readonly record: string };

export const retentionCrashArgument = (crash: RoleMainRetentionCrash): string => `${RETENTION_CRASH_FLAG}${JSON.stringify(crash)}`;

const retentionCrashPointOf = (argv: readonly string[]): (() => void) | undefined => {
  const given = argv.find((argument) => argument.startsWith(RETENTION_CRASH_FLAG));
  if (given === undefined) return undefined;
  const crash = JSON.parse(given.slice(RETENTION_CRASH_FLAG.length)) as RoleMainRetentionCrash;
  return () => {
    if (!fs.existsSync(crash.marker)) return;
    fs.appendFileSync(crash.record, 'crashed\n');
    fs.rmSync(crash.marker, { force: true });
    process.kill(process.pid, 'SIGKILL');
  };
};

const fileSystemOf = (argv: readonly string[]): FileSystem => {
  const given = argv.find((argument) => argument.startsWith(FILE_FAULT_FLAG));
  if (given === undefined) return nodeFileSystem;
  const fault = JSON.parse(given.slice(FILE_FAULT_FLAG.length)) as RoleMainFileFault;
  return fileSystemWithFault(nodeFileSystem, {
    code: fault.code,
    under: fault.under,
    holds: () => fs.existsSync(fault.marker),
    refused: (file) => fs.appendFileSync(fault.record, `${file}\n`),
  });
};

export const roleMain = (argv: readonly string[]): Promise<number> => {
  const [role, version, ...rest] = argv;
  if (version === undefined) throw new Error('role-main needs the role and the version it reports as its first two arguments');
  const entryArgv = rest.filter((argument) => !argument.startsWith(FILE_FAULT_FLAG) && !argument.startsWith(RETENTION_CRASH_FLAG));
  const io = { ...nodeEntryIo(), argv: entryArgv };
  if (role === 'gateway') return runGatewayEntry(io, { version });
  if (role === 'runtime') {
    const retentionCrashPoint = retentionCrashPointOf(rest);
    return runRuntimeEntry(io, { version, helperSelf: { execPath: process.execPath, script: PRODUCT_ENTRY }, fileSystem: fileSystemOf(rest), ...(retentionCrashPoint === undefined ? {} : { retentionCrashPoint }) });
  }
  throw new Error(`role-main: unknown role ${role}`);
};

if (import.meta.main) void roleMain(process.argv.slice(2));
