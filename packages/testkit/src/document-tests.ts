import { it } from 'vitest';
import { documentFolderOf } from './document-folders.ts';
import type { DocumentVariable } from './document-folders.ts';

export const itWithDocuments = (variable: DocumentVariable, _start: string, title: string, check: (folder: string) => void | Promise<void>): void => {
  const found = documentFolderOf(variable);
  if (found.kind === 'named') {
    it(title, () => check(found.folder));
    return;
  }
  it(title, (context) => context.skip(`${variable} is not set`));
};
