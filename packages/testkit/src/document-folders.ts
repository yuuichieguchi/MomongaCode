import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENTS_FOLDER_NAME = 'MomongaCode-docs';

export const DOCUMENT_FOLDERS = { MOMONGA_CONSTANTS_DOCUMENT: 'constants', MOMONGA_DESIGN_DOCUMENTS: 'design' } as const;

export type DocumentVariable = keyof typeof DOCUMENT_FOLDERS;

export const DOCUMENT_VARIABLES = Object.keys(DOCUMENT_FOLDERS) as DocumentVariable[];

export const siblingDocumentsOf = (start: string): string | undefined => {
  for (let directory = path.resolve(start); path.dirname(directory) !== directory; directory = path.dirname(directory)) {
    const candidate = path.join(path.dirname(directory), DOCUMENTS_FOLDER_NAME);
    if (fs.existsSync(path.join(candidate, DOCUMENT_FOLDERS.MOMONGA_DESIGN_DOCUMENTS))) return candidate;
  }
  return undefined;
};

export const documentEnvironmentOf = (start: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const documents = siblingDocumentsOf(start);
  if (documents === undefined) return {};
  return Object.fromEntries(DOCUMENT_VARIABLES.filter((variable) => env[variable] === undefined).map((variable) => [variable, path.join(documents, DOCUMENT_FOLDERS[variable])]));
};

export type DocumentFolder = { readonly kind: 'named'; readonly folder: string } | { readonly kind: 'absent' } | { readonly kind: 'unnamed'; readonly expected: string };

export const documentFolderOf = (variable: DocumentVariable, start: string, env: Readonly<Record<string, string | undefined>> = process.env): DocumentFolder => {
  const named = env[variable];
  if (named !== undefined) return { kind: 'named', folder: named };
  const documents = siblingDocumentsOf(start);
  return documents === undefined ? { kind: 'absent' } : { kind: 'unnamed', expected: path.join(documents, DOCUMENT_FOLDERS[variable]) };
};

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
