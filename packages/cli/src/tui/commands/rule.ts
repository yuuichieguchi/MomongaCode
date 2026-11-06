import { formatRuleAdded, formatRuleHistory, formatRuleList } from '../../rule/format.ts';
import type { SlashCommand } from '../slash.ts';
import { runShellCommand } from './shell-commands.ts';

const USAGE = 'usage: /rule [list] | /rule add <target> <text> [--kind <kind>] [--deny <rule>] [--ask <rule>] [--path <glob>] [--until <date>] | /rule retire <id> | /rule history <id>';

const ADD = /^add\s+(\S+)\s+(\S[\s\S]*)$/;

export const ruleCommand: SlashCommand = {
  name: 'rule',
  usage: '[list|add <target> <text>|retire <id>|history <id>]',
  description: 'list, add, retire or show the history of the standing rules of this folder',
  run: async (args, context) => {
    const text = args.trim();
    if (/^add\s/.test(text) && /\s--\S/.test(text)) {
      await runShellCommand('rule', text, context, false);
      return;
    }
    const added = ADD.exec(text);
    if (added !== null) {
      const [, target = '', ruleText = ''] = added;
      const response = await context.backend.addRule({ kind: 'constraint', target, text: ruleText, scope: { level: 'project', project: context.backend.cwd, paths: [] } });
      context.info(formatRuleAdded(response));
      return;
    }
    const [action = 'list', id, ...rest] = text.split(/\s+/).filter((part) => part !== '');
    if (rest.length > 0) {
      context.info(USAGE);
      return;
    }
    if (action === 'list' && id === undefined) {
      context.info(formatRuleList(await context.backend.rules()));
      return;
    }
    if (action === 'retire' && id !== undefined) {
      const retired = await context.backend.retireRule(id);
      context.info(`retired rule ${retired.id}`);
      return;
    }
    if (action === 'history' && id !== undefined) {
      context.info(formatRuleHistory(await context.backend.ruleHistory(id)));
      return;
    }
    context.info(USAGE);
  },
};
