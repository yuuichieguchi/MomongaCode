import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENT_FOLDERS = { MOMONGA_CONSTANTS_DOCUMENT: 'constants', MOMONGA_DESIGN_DOCUMENTS: 'design' } as const;

export type DocumentVariable = keyof typeof DOCUMENT_FOLDERS;

export const DOCUMENT_VARIABLES = Object.keys(DOCUMENT_FOLDERS) as DocumentVariable[];

export type DocumentFolder =
  | { readonly kind: 'named'; readonly folder: string }
  | { readonly kind: 'absent' };

export const documentFolderOf = (variable: DocumentVariable, _start?: string, env: Readonly<Record<string, string | undefined>> = process.env): DocumentFolder => {
  const named = env[variable];
  if (named !== undefined && named.trim() !== '') return { kind: 'named', folder: named };
  return { kind: 'absent' };
};

const filesUnder = (directory: string): string[] =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []))
    .sort();

export const documentFolderDigestOf = (folder: string): string => {
  const hash = createHash('sha256');
  if (!fs.existsSync(folder)) return 'absent';
  for (const file of fs.statSync(folder).isDirectory() ? filesUnder(folder) : [folder]) hash.update(`${path.relative(folder, file)}\0`).update(fs.readFileSync(file)).update('\0');
  return hash.digest('hex');
};
