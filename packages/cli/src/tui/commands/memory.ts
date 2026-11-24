import path from 'node:path';
import { formatMemory, formatMemoryList, memoryAutoReviewText } from '../../memory/format.ts';
import { openEdit } from '../models/context.ts';
import { memoryReviewStateOf, runMemoryReviewModelFlow, savingIn, setMemoryAutoReview } from '../models/order.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import { runShellCommand } from './shell-commands.ts';
import { openInEditor } from './skills.ts';

export const OPEN_AGENTS_FILE_ROW = 'Open AGENTS.md';
export const AGENTS_FILE_NAME = 'AGENTS.md';

const USAGE =
  'usage: /memory [list] | /memory open (Open AGENTS.md in $EDITOR) | /memory show <id> | /memory delete <id> (retires the memory; it stays in /memory history) | /memory add <text> | /memory history <id> | /memory review | /memory restore <id> | /memory promote <id> --skill <name> | /memory auto [on|off|model]';

const runAutoReview = async (context: SlashContext, choice: string | undefined): Promise<void> => {
  const opened = await openEdit(context);
  if (choice === 'model') {
    await runMemoryReviewModelFlow(context, opened);
    return;
  }
  const state = choice === undefined ? memoryReviewStateOf(opened.edit) : await setMemoryAutoReview(context, savingIn(context), opened, choice === 'on');
  if (state !== undefined) context.info(memoryAutoReviewText(state, opened.edit.displays));
};

const AUTO_REVIEW_CHOICES: ReadonlySet<string | undefined> = new Set([undefined, 'on', 'off', 'model']);

const SHARED_WITH_SHELL: ReadonlySet<string> = new Set(['add', 'history', 'review', 'restore', 'promote']);

export const memoryCommand: SlashCommand = {
  name: 'memory',
  usage: '[list|open|show <id>|delete <id>|add <text>|history <id>|review|restore <id>|promote <id> --skill <name>|auto [on|off|model]]',
  description: 'list, show, add, review, restore, promote or retire the memories of this folder and of all folders',
  subcommands: [
    { name: 'list', description: 'list the memories of this folder and of all folders' },
    { name: 'open', description: 'open AGENTS.md in $EDITOR' },
    { name: 'show', usage: '<id>', description: 'show one memory' },
    { name: 'delete', usage: '<id>', description: 'retire one memory; it stays in /memory history' },
    { name: 'add', usage: '<text>', description: 'add a memory' },
    { name: 'history', usage: '<id>', description: 'show the history of one memory' },
    {
      name: 'review',
      usage: '[accept <id> | reject <id>]',
      description: 'review memories',
      standalone: true,
      subcommands: [
        { name: 'accept', usage: '<id>', description: 'accept one memory under review' },
        { name: 'reject', usage: '<id>', description: 'reject one memory under review' },
      ],
    },
    { name: 'restore', usage: '<id>', description: 'restore a retired memory' },
    { name: 'promote', usage: '<id> --skill <name>', description: 'promote a memory into a skill' },
    { name: 'auto', usage: '[on|off|model]', description: 'turn memory auto review on or off, or choose its model' },
  ],
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
    if (action === 'auto' && AUTO_REVIEW_CHOICES.has(id)) {
      await runAutoReview(context, id);
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
      context.info(formatMemory(await context.backend.memory(id), context.shownModel));
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
