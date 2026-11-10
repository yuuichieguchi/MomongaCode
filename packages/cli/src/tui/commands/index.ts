import { BUILTIN_SLASH_COMMANDS } from '../slash.ts';
import type { SlashCommand } from '../slash.ts';
import { autoModeCommand } from './auto-mode.ts';
import { markersCommand } from './markers.ts';
import { memoryCommand } from './memory.ts';
import { ruleCommand } from './rule.ts';
import { shellSlashCommands } from './shell-commands.ts';
import { tuiCommand } from './tui.ts';

export const DEFAULT_SLASH_COMMANDS: readonly SlashCommand[] = [...BUILTIN_SLASH_COMMANDS, autoModeCommand, markersCommand, memoryCommand, ruleCommand, tuiCommand, ...shellSlashCommands];
