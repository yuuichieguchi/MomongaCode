import { BUILTIN_SLASH_COMMANDS } from '../slash.ts';
import type { SlashCommand } from '../slash.ts';
import { memoryCommand } from './memory.ts';
import { ruleCommand } from './rule.ts';

export const DEFAULT_SLASH_COMMANDS: readonly SlashCommand[] = [...BUILTIN_SLASH_COMMANDS, memoryCommand, ruleCommand];
