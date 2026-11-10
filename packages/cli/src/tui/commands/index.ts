import { BUILTIN_SLASH_COMMANDS } from '../slash.ts';
import type { SlashCommand } from '../slash.ts';
import { autoModeCommand } from './auto-mode.ts';
import { clearCommand } from './clear.ts';
import { configCommand } from './config.ts';
import { hooksCommand } from './hooks.ts';
import { initCommand } from './init.ts';
import { keybindingsCommand } from './keybindings.ts';
import { mcpCommand } from './mcp.ts';
import { permissionsCommand } from './permissions.ts';
import { markersCommand } from './markers.ts';
import { memoryCommand } from './memory.ts';
import { resumeCommand } from './resume.ts';
import { ruleCommand } from './rule.ts';
import { shellSlashCommands } from './shell-commands.ts';
import { themeCommand } from './theme.ts';
import { tuiCommand } from './tui.ts';

export const DEFAULT_SLASH_COMMANDS: readonly SlashCommand[] = [...BUILTIN_SLASH_COMMANDS, clearCommand, resumeCommand, autoModeCommand, markersCommand, memoryCommand, ruleCommand, tuiCommand, themeCommand, keybindingsCommand, configCommand, permissionsCommand, hooksCommand, mcpCommand, initCommand, ...shellSlashCommands];
