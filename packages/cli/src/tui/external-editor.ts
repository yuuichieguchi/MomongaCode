import path from 'node:path';

export const EDITOR_VARIABLES = ['VISUAL', 'EDITOR'] as const;

export const EDITOR_UNSET_HINT = 'Set $EDITOR to use ctrl+g.';

export type ExternalEdit = { kind: 'edited'; text: string } | { kind: 'unset' };

export type ExternalEditorPort = { edit(draft: string): Promise<ExternalEdit> };

export type ExternalEditorHost = {
  env: Readonly<Record<string, string | undefined>>;
  temporaryDirectory(): Promise<string>;
  writePrivate(file: string, text: string): Promise<void>;
  read(file: string): Promise<string>;
  remove(directory: string): Promise<void>;
  leaveScreen(): () => void;
  launch(argv: readonly string[]): Promise<void>;
};

const DRAFT_FILE = 'draft.md';

const commandOf = (env: ExternalEditorHost['env']): string[] | undefined => {
  for (const name of EDITOR_VARIABLES) {
    const words = env[name]?.split(/\s+/).filter((word) => word !== '');
    if (words !== undefined && words.length > 0) return words;
  }
  return undefined;
};

export const createExternalEditor = (host: ExternalEditorHost): ExternalEditorPort => ({
  edit: async (draft) => {
    const command = commandOf(host.env);
    if (command === undefined) return { kind: 'unset' };
    const directory = await host.temporaryDirectory();
    try {
      const file = path.join(directory, DRAFT_FILE);
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
