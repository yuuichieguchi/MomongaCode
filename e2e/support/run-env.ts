import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { shortTempBase } from '@momonga/foundation';

export const E2E_RUN_ENV = 'MOMONGA_E2E_RUN';
export const E2E_RUN_PATTERN = /^[0-9a-f]{4}$/;
export const E2E_DIR_PREFIX = 'mme-';
export const LIVE_MARKER_SUFFIX = 'live';
export const PIDS_FILE_SUFFIX = 'pids';
export const PRIVATE_ROOT_MODE = 0o700;
export const HARNESS_FILE_MODE = 0o600;

const GROUP_OR_OTHER_BITS = 0o077;
const UNOWNED_PRIVATE_ROOT_NAME = `${E2E_DIR_PREFIX}user`;

export type PrivateRootIdentity = { readonly uid: number | undefined };

export const currentIdentity = (): PrivateRootIdentity => ({ uid: process.getuid?.() });

export const privateRootName = (identity: PrivateRootIdentity): string => (identity.uid === undefined ? UNOWNED_PRIVATE_ROOT_NAME : `${E2E_DIR_PREFIX}${identity.uid}`);

const refuse = (root: string, check: string): never => {
  throw new Error(`e2e private temp dir ${root} is refused: ${check}`);
};

export const verifyPrivateRoot = (root: string, identity: PrivateRootIdentity = currentIdentity()): string => {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) refuse(root, 'it is a symbolic link');
  if (!stat.isDirectory()) refuse(root, 'it is not a directory');
  if (identity.uid === undefined) return root;
  if (stat.uid !== identity.uid) refuse(root, `it is owned by uid ${stat.uid}, not by uid ${identity.uid}`);
  if ((stat.mode & GROUP_OR_OTHER_BITS) !== 0) refuse(root, `its mode ${(stat.mode & 0o777).toString(8)} grants group or other permissions`);
  return root;
};

export const privateTempRoot = (base: string, identity: PrivateRootIdentity = currentIdentity()): string => {
  const root = path.join(base, privateRootName(identity));
  try {
    fs.mkdirSync(root, { mode: PRIVATE_ROOT_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return verifyPrivateRoot(root, identity);
};

export const sharedTempBase = (): string => fs.realpathSync(shortTempBase(process.platform, os.tmpdir()));

export const e2eTmpRoot = (): string => privateTempRoot(sharedTempBase());

export const e2eEntryPrefix = (run: string): string => `${E2E_DIR_PREFIX}${run}-`;

export const harnessFilePath = (tmpRoot: string, run: string, suffix: string): string => path.join(tmpRoot, `${e2eEntryPrefix(run)}${suffix}`);

const CREATE_HARNESS_FILE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const APPEND_HARNESS_FILE = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
const READ_HARNESS_FILE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

const writeAndClose = (fd: number, text: string): void => {
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
};

export const createHarnessFile = (file: string, text: string): void => {
  writeAndClose(fs.openSync(file, CREATE_HARNESS_FILE, HARNESS_FILE_MODE), text);
};

export const appendHarnessFile = (file: string, text: string): void => {
  let fd: number;
  try {
    fd = fs.openSync(file, CREATE_HARNESS_FILE | fs.constants.O_APPEND, HARNESS_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fd = fs.openSync(file, APPEND_HARNESS_FILE);
  }
  writeAndClose(fd, text);
};

export const readHarnessFile = (file: string): string => {
  const fd = fs.openSync(file, READ_HARNESS_FILE);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
};
