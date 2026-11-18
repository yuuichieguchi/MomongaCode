import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENTS_FOLDER_NAME = 'MomongaCode-docs';

export const DOCUMENT_FOLDERS = { MOMONGA_CONSTANTS_DOCUMENT: 'constants', MOMONGA_DESIGN_DOCUMENTS: 'design' } as const;

export type DocumentVariable = keyof typeof DOCUMENT_FOLDERS;

export const DOCUMENT_VARIABLES = Object.keys(DOCUMENT_FOLDERS) as DocumentVariable[];

const repositoryRootOf = (start: string): string => {
  for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    if (path.dirname(directory) === directory) throw new Error(`${start} is inside no git checkout`);
  }
};

export const mainCheckoutRootOf = (start: string): string => {
  const root = repositoryRootOf(start);
  const dotGit = path.join(root, '.git');
  if (fs.statSync(dotGit).isDirectory()) return root;
  const pointer = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (pointer === null) throw new Error(`${dotGit} names no git directory`);
  const gitDir = path.resolve(root, (pointer[1] as string).trim());
  const commonFile = path.join(gitDir, 'commondir');
  const commonDir = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
  return path.dirname(commonDir);
};

export type DocumentsLocation = { readonly kind: 'found'; readonly folder: string } | { readonly kind: 'absent' } | { readonly kind: 'refused'; readonly folder: string; readonly reason: string };

const refusalOf = (folder: string): string | undefined => {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory()) return 'it is not a directory';
  if (process.getuid !== undefined && stat.uid !== process.getuid()) return `it is owned by uid ${stat.uid}, not by the current user`;
  if ((stat.mode & 0o022) !== 0) return `group or others may write it (mode ${(stat.mode & 0o777).toString(8)})`;
  return undefined;
};

export const documentsLocationOf = (start: string): DocumentsLocation => {
  const folder = path.join(path.dirname(mainCheckoutRootOf(start)), DOCUMENTS_FOLDER_NAME);
  if (!fs.existsSync(folder)) return { kind: 'absent' };
  for (const checked of [folder, ...Object.values(DOCUMENT_FOLDERS).map((part) => path.join(folder, part)).filter((part) => fs.existsSync(part))]) {
    const reason = refusalOf(checked);
    if (reason !== undefined) return { kind: 'refused', folder: checked, reason };
  }
  return { kind: 'found', folder };
};

export const documentEnvironmentOf = (start: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const location = documentsLocationOf(start);
  if (location.kind !== 'found') return {};
  return Object.fromEntries(DOCUMENT_VARIABLES.filter((variable) => env[variable] === undefined).map((variable) => [variable, path.join(location.folder, DOCUMENT_FOLDERS[variable])]));
};

export type DocumentFolder =
  | { readonly kind: 'named'; readonly folder: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unnamed'; readonly expected: string }
  | { readonly kind: 'refused'; readonly folder: string; readonly reason: string };

export const documentFolderOf = (variable: DocumentVariable, start: string, env: Readonly<Record<string, string | undefined>> = process.env): DocumentFolder => {
  const named = env[variable];
  if (named !== undefined) return { kind: 'named', folder: named };
  const location = documentsLocationOf(start);
  if (location.kind === 'found') return { kind: 'unnamed', expected: path.join(location.folder, DOCUMENT_FOLDERS[variable]) };
  return location;
};

export const refusedDocumentsMessage = (folder: string, reason: string): string => `the documents folder ${folder} is not used: ${reason}; the checks that read it fail until it is owned by the current user and writable by no one else`;

export const unnamedDocumentsMessage = (variable: DocumentVariable, expected: string): string =>
  `the documents folder ${expected} exists beside the repository, but ${variable} does not name it, so this check would be skipped; vitest.config.ts sets it, or set it by hand`;

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
