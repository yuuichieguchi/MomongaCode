import path from 'node:path';
import { commandWords } from './command-words.ts';
import type { KeyTable } from './keys/table.ts';

export const EDITOR_VARIABLES = ['VISUAL', 'EDITOR'] as const;

export const editorUnsetHint = (keys: KeyTable): string => {
  const key = keys.keyHint('editor.external');
  return key === '' ? 'Set $EDITOR to edit the draft in an editor.' : `Set $EDITOR to use ${key}.`;
};

export type ExternalEdit = { kind: 'edited'; text: string } | { kind: 'unset' };

export type EditedText = 'draft' | 'json';

export type ExternalEditorPort = { edit(draft: string, kind: EditedText): Promise<ExternalEdit> };

export type ExternalEditorHost = {
  env: Readonly<Record<string, string | undefined>>;
  temporaryDirectory(): Promise<string>;
  writePrivate(file: string, text: string): Promise<void>;
  read(file: string): Promise<string>;
  remove(directory: string): Promise<void>;
  leaveScreen(): () => void;
  launch(argv: readonly string[]): Promise<void>;
};

const EDITED_FILES: Readonly<Record<EditedText, string>> = { draft: 'draft.md', json: 'value.json' };

const commandOf = (env: ExternalEditorHost['env']): readonly string[] | undefined => {
  for (const name of EDITOR_VARIABLES) {
    const value = env[name];
    if (value === undefined) continue;
    const parsed = commandWords(value);
    if (parsed.kind === 'refused') throw new Error(`the variable ${name} cannot be read: ${parsed.reason}`);
    if (parsed.words.length > 0) return parsed.words;
  }
  return undefined;
};

export const createExternalEditor = (host: ExternalEditorHost): ExternalEditorPort => ({
  edit: async (draft, kind) => {
    const command = commandOf(host.env);
    if (command === undefined) return { kind: 'unset' };
    const directory = await host.temporaryDirectory();
    try {
      const file = path.join(directory, EDITED_FILES[kind]);
      await host.writePrivate(file, draft);
      const returnToScreen = host.leaveScreen();
      try {
        await host.launch([...command, file]);
      } finally {
        returnToScreen();
      }
      return { kind: 'edited', text: (await host.read(file)).replace(/\n$/, '') };
    } finally {
      await host.remove(directory);
    }
  },
});
