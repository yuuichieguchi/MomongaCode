import fs from 'node:fs';
import path from 'node:path';
import { SandboxPolicyError } from './policy-error.ts';

export function assertExistingDirectory(root: string): void {
  if (!path.isAbsolute(root)) throw new SandboxPolicyError('writable_root_not_absolute', `writable root must be absolute: ${root}`, { path: root });
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
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
