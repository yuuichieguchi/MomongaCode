import type { AllowedToolsChoice, ResponseToolChoice, ToolChoice, ToolChoiceMode } from '@momonga/protocol';

export const isAllowedTools = (choice: ToolChoice | null | undefined): choice is AllowedToolsChoice =>
  typeof choice === 'object' && choice !== null && choice.type === 'allowed_tools';

export const allowedToolsModeOf = (choice: AllowedToolsChoice): ToolChoiceMode => choice.mode ?? 'auto';

export const allowedNamesOf = (choice: AllowedToolsChoice): string[] => [...new Set(choice.tools.map((tool) => tool.name))];

export const forbidsTools = (choice: ToolChoice | null | undefined): boolean =>
  choice === 'none' || (isAllowedTools(choice) && allowedToolsModeOf(choice) === 'none');

export const echoedToolChoice = (choice: ToolChoice | null | undefined): ResponseToolChoice => {
  if (choice === undefined || choice === null) return 'auto';
  return isAllowedTools(choice) ? { ...choice, mode: allowedToolsModeOf(choice) } : choice;
};
