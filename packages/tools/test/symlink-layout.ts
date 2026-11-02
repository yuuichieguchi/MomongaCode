import fs from 'node:fs';
import path from 'node:path';

export type SymlinkReadLine = {
  program: string;
  argv: string[];
  link: 'tree' | 'operand';
  mode: 'default' | 'acceptEdits';
  exit: number;
  readsThrough: boolean;
};

export const SYMLINK_READ_LINES: readonly SymlinkReadLine[] = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'symlink-reads.json'), 'utf8'),
) as SymlinkReadLine[];

export const SECRET_CONTENT = 'TOPSECRET x\n';
export const SECRET_ENTRY = 'innerSecretName';

export const buildSymlinkLayout = (dir: string): void => {
  fs.mkdirSync(path.join(dir, 'out', 'd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 's'), SECRET_CONTENT);
  fs.writeFileSync(path.join(dir, 'out', 'd', SECRET_ENTRY), SECRET_CONTENT);
  for (const tree of ['a', 'b', 'c']) fs.mkdirSync(path.join(dir, tree));
  fs.symlinkSync('../out/s', path.join(dir, 'a', 'l'));
  fs.symlinkSync('../out/d', path.join(dir, 'a', 'ld'));
  fs.writeFileSync(path.join(dir, 'a', 'x'), 'TOPSECRET\n');
  fs.writeFileSync(path.join(dir, 'c', 'l'), SECRET_CONTENT);
  fs.mkdirSync(path.join(dir, 'c', 'ld'));
  fs.writeFileSync(path.join(dir, 'c', 'ld', SECRET_ENTRY), SECRET_CONTENT);
  fs.writeFileSync(path.join(dir, 'c', 'x'), 'TOPSECRET\n');
  for (const name of ['l', 'x']) fs.writeFileSync(path.join(dir, 'b', name), 'plain\n');
  fs.mkdirSync(path.join(dir, 'b', 'ld'));
};
