import type { AdapterRequest, AllowedToolsForm, FunctionTool, ToolChoice } from '@momonga/protocol';
import { allowedNamesOf, allowedToolsModeOf, isAllowedTools } from '../../core/tool-choice.ts';
import { UnsupportedInputError } from './failures.ts';

export type ToolChoiceWire = {
  forms: readonly AllowedToolsForm[];
  expressesRequired: boolean;
};

const FORM_PREFERENCE: readonly AllowedToolsForm[] = ['native', 'envelope', 'single_tool', 'filter'];

const refusal = (target: string, reason: string): UnsupportedInputError =>
  new UnsupportedInputError('unsupported_tool_choice', `tool_choice of type allowed_tools cannot be sent to target "${target}": ${reason}`, 'tool_choice');

const rewritten = (request: AdapterRequest, toolChoice: ToolChoice, tools?: readonly FunctionTool[]): AdapterRequest => ({
  ...request,
  tool_choice: toolChoice,
  ...(tools === undefined ? {} : { tools: [...tools] }),
});

export const resolveToolChoice = (request: AdapterRequest, declared: readonly AllowedToolsForm[] | undefined, target: string, wire: ToolChoiceWire): AdapterRequest => {
  const choice = request.tool_choice;
  if (!isAllowedTools(choice)) return request;
  const mode = allowedToolsModeOf(choice);
  if (mode === 'none') return rewritten(request, 'none');
  const names = allowedNamesOf(choice);
  const tools = request.tools ?? [];
  if (tools.length > 0 && tools.every((tool) => names.includes(tool.name))) return rewritten(request, mode);
  if (declared === undefined || declared.length === 0) {
    throw refusal(target, 'the target declares no capabilities.allowedTools form, so it has no way to restrict the tool choice to a set');
  }
  const usable = FORM_PREFERENCE.filter((form) => declared.includes(form) && wire.forms.includes(form));
  for (const form of usable) {
    switch (form) {
      case 'native':
      case 'envelope':
        return rewritten(request, { type: 'allowed_tools', tools: names.map((name) => ({ type: 'function', name })), mode });
      case 'single_tool': {
        const [only] = names;
        if (mode === 'required' && names.length === 1 && only !== undefined) return rewritten(request, { type: 'function', name: only });
        break;
      }
      case 'filter':
        if (mode === 'auto' || wire.expressesRequired) {
          return rewritten(request, mode, tools.filter((tool) => names.includes(tool.name)));
        }
        break;
    }
  }
  throw refusal(
    target,
    `none of its declared capabilities.allowedTools forms (${declared.join(', ')}) can express mode ${mode} over ${names.length} of ${tools.length} tools on this wire`,
  );
};
