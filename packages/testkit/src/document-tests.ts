import { it } from 'vitest';
import { DOCUMENTS_FOLDER_NAME, documentFolderOf, unnamedDocumentsMessage } from './document-folders.ts';
import type { DocumentVariable } from './document-folders.ts';

export const itWithDocuments = (variable: DocumentVariable, start: string, title: string, check: (folder: string) => void | Promise<void>): void => {
  const found = documentFolderOf(variable, start);
  if (found.kind === 'named') {
    it(title, () => check(found.folder));
    return;
  }
  if (found.kind === 'absent') {
    it(title, (context) => context.skip(`${variable} names no folder and no ${DOCUMENTS_FOLDER_NAME} folder is beside the repository in this run`));
    return;
  }
  it(title, () => {
    throw new Error(unnamedDocumentsMessage(variable, found.expected));
  });
};
