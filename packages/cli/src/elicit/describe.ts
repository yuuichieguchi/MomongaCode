import type { ElicitationRequestView } from '@momonga/protocol';
import { fieldsOf } from './form.ts';
import type { FormField } from './form.ts';

export const elicitCommand = (inputId: string, flags: string): string => `momonga elicit ${inputId} ${flags}`;

const fieldPlaceholder = (field: FormField): string => `--set ${field.name}=<${field.kind === 'choice' ? field.options.map((option) => option.value).join('|') : field.kind}>`;

const describeField = (field: FormField): string =>
  `    ${field.name} (${field.kind}, ${field.required ? 'required' : 'optional'})${field.title === field.name ? '' : `: ${field.title}`}${field.description === undefined ? '' : ` - ${field.description}`}`;

const describeRequest = (request: ElicitationRequestView): string[] =>
  request.mode === 'url'
    ? [`  [${request.key}] ${request.message}`, `    URL: ${request.url}`]
    : [`  [${request.key}] ${request.message}`, ...fieldsOf(request.requestedSchema).map(describeField)];

const acceptFlags = (request: ElicitationRequestView): string =>
  request.mode === 'url' ? '--accept' : ['--accept', ...fieldsOf(request.requestedSchema).map((field) => (field.required ? fieldPlaceholder(field) : `[${fieldPlaceholder(field)}]`))].join(' ');

export const describeElicitation = (inputId: string, server: string, title: string, requests: readonly ElicitationRequestView[]): string => {
  const [only] = requests;
  const accept =
    requests.length === 1 && only !== undefined
      ? [`  accept:  ${elicitCommand(inputId, acceptFlags(only))}${only.mode === 'url' ? '   (opens the URL in your browser)' : ''}`]
      : [`  accept:  ${elicitCommand(inputId, "--responses '<json: request key -> {\"action\":\"accept\",\"content\":{...}}>'")}`];
  return [
    `${inputId}  MCP server ${server} asks for input (${title})`,
    ...requests.flatMap(describeRequest),
    ...accept,
    `  decline: ${elicitCommand(inputId, '--decline')}`,
    `  cancel:  ${elicitCommand(inputId, '--cancel')}`,
  ].join('\n');
};
