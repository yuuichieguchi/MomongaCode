import { describe, expect, it } from 'vitest';
import { createExternalEditor, editorUnsetHint } from '../../src/tui/external-editor.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import type { ExternalEditorHost } from '../../src/tui/external-editor.ts';

const hostOf = (env: ExternalEditorHost['env'], edit: (text: string) => string = (text) => text) => {
  const steps: string[] = [];
  const files = new Map<string, string>();
  const host: ExternalEditorHost = {
    env,
    temporaryDirectory: async () => '/tmp/draft-1',
    writePrivate: async (file, text) => {
      steps.push(`write ${file}`);
      files.set(file, text);
    },
    read: async (file) => {
      steps.push(`read ${file}`);
      const text = files.get(file);
      if (text === undefined) throw new Error(`no file ${file}`);
      return text;
    },
    remove: async (directory) => {
      steps.push(`remove ${directory}`);
    },
    leaveScreen: () => {
      steps.push('leave the screen');
      return () => void steps.push('return to the screen');
    },
    launch: async (argv) => {
      steps.push(`launch ${argv.join(' ')}`);
      const file = argv.at(-1) ?? '';
      files.set(file, edit(files.get(file) ?? ''));
    },
  };
  return { host, steps };
};

describe('the external editor', () => {
  it('opens $VISUAL on a private file holding the draft, between leaving and re-entering the screen, and reads the file back', async () => {
    const { host, steps } = hostOf({ VISUAL: 'code -w', EDITOR: 'vi' }, (text) => `${text} and more\n`);
    expect(await createExternalEditor(host).edit('the draft')).toEqual({ kind: 'edited', text: 'the draft and more' });
    expect(steps).toEqual(['write /tmp/draft-1/draft.md', 'leave the screen', 'launch code -w /tmp/draft-1/draft.md', 'return to the screen', 'read /tmp/draft-1/draft.md', 'remove /tmp/draft-1']);
  });

  it('uses $EDITOR when $VISUAL is not set', async () => {
    const { host, steps } = hostOf({ EDITOR: 'vi' });
    await createExternalEditor(host).edit('x');
    expect(steps).toContain('launch vi /tmp/draft-1/draft.md');
  });

  it('starts nothing when neither variable is set', async () => {
    const { host, steps } = hostOf({ VISUAL: ' ' });
    expect(await createExternalEditor(host).edit('x')).toEqual({ kind: 'unset' });
    expect(steps).toEqual([]);
    expect(editorUnsetHint(DEFAULT_KEY_TABLE)).toBe('Set $EDITOR to use ctrl+g.');
  });

  it('re-enters the screen and removes the file when the editor cannot be started', async () => {
    const { host, steps } = hostOf({ EDITOR: 'missing' });
    host.launch = async () => {
      throw new Error('spawn missing ENOENT');
    };
    await expect(createExternalEditor(host).edit('x')).rejects.toThrow('spawn missing ENOENT');
    expect(steps).toEqual(['write /tmp/draft-1/draft.md', 'leave the screen', 'return to the screen', 'remove /tmp/draft-1']);
  });
});
