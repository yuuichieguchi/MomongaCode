import path from 'node:path';
import { formatMemory, formatMemoryList } from '../../memory/format.ts';
import type { SlashCommand } from '../slash.ts';
import { runShellCommand } from './shell-commands.ts';
import { openInEditor } from './skills.ts';

export const OPEN_AGENTS_FILE_ROW = 'Open AGENTS.md';
export const AGENTS_FILE_NAME = 'AGENTS.md';

const USAGE =
  'usage: /memory [list] | /memory open (Open AGENTS.md in $EDITOR) | /memory show <id> | /memory delete <id> (retires the memory; it stays in /memory history) | /memory add <text> | /memory history <id> | /memory review | /memory restore <id> | /memory promote <id> --skill <name>';

const SHARED_WITH_SHELL: ReadonlySet<string> = new Set(['add', 'history', 'review', 'restore', 'promote']);

export const memoryCommand: SlashCommand = {
  name: 'memory',
  usage: '[list|open|show <id>|delete <id>|add <text>|history <id>|review|restore <id>|promote <id> --skill <name>]',
  description: 'list, show, add, review, restore, promote or retire the memories of this folder and of all folders',
  run: async (args, context) => {
    const first = args.split(/\s+/)[0] ?? '';
    if (SHARED_WITH_SHELL.has(first)) {
      await runShellCommand('memory', args, context);
      return;
    }
    const [action = 'list', id, ...rest] = args.split(/\s+/).filter((part) => part !== '');
    if (rest.length > 0) {
      context.info(USAGE);
      return;
    }
    if (action === 'list' && id === undefined) {
      context.info(formatMemoryList(await context.backend.memories()));
      return;
    }
    if (action === 'open' && id === undefined) {
      await openInEditor(context, path.join(context.backend.cwd, AGENTS_FILE_NAME));
      return;
    }
    if (action === 'show' && id !== undefined) {
      context.info(formatMemory(await context.backend.memory(id)));
      return;
    }
    if (action === 'delete' && id !== undefined) {
      await context.backend.deleteMemory(id);
      context.info(`retired memory ${id}; it stays in /memory history`);
      return;
    }
    context.info(USAGE);
  },
};
