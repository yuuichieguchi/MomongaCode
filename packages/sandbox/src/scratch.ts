import fs from 'node:fs';
import path from 'node:path';
import { SandboxPolicyError } from './policy-error.ts';

export type DirectoryPort = { isDirectory(target: string): boolean };

export const nodeDirectoryPort: DirectoryPort = { isDirectory: (target) => fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() === true };

export function assertExistingDirectory(root: string, port: DirectoryPort = nodeDirectoryPort): void {
  if (!path.isAbsolute(root)) throw new SandboxPolicyError('writable_root_not_absolute', `writable root must be absolute: ${root}`, { path: root });
  if (!port.isDirectory(root)) {
    throw new SandboxPolicyError('writable_root_missing', `writable root does not exist or is not a directory: ${root}`, { path: root });
  }
}

export function removePrivateTmpDir(dir: string): void {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(dir);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
