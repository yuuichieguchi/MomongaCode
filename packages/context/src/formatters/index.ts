import { parseOutsideJson } from '@momonga/foundation';
import { asciiLower } from '@momonga/protocol';
import type { OutputFormatterName } from '@momonga/protocol';
import { formatGrep } from './grep.ts';
import { formattingViolations } from './invariants.ts';
import type { FormattingViolation } from './invariants.ts';
import { formatJson, isUnreadableJson } from './json.ts';
import { formatLog } from './log.ts';
import { readClauseOf } from '../tool-output.ts';

export { formattingViolations, formatGrep, formatJson, formatLog };
export type { FormattingViolation };

export type FormattedOutput = { output: string; formatter: 'log' | 'json' | 'grep'; version: number };

export const FORMATTER_VERSIONS = { log: 1, json: 1, grep: 1 } as const;

const HANDLE_PLACEHOLDER = '0'.repeat(64);

export const formattedHeader = (formatter: FormattedOutput['formatter'], handle: string, reader: string | undefined): string =>
  `[formatted by ${formatter}; raw output ${handle}${readClauseOf(reader)}]`;

const GREP_TOOL = 'Grep';
const EXECUTE_KIND = 'execute';

const parsesAsJson = (output: string): boolean => {
  try {
    parseOutsideJson(output);
    return true;
  } catch (error) {
    if (isUnreadableJson(error)) return false;
    throw error;
  }
};

const selectedFormatter = (input: {
  output: string;
  status: 'completed' | 'failed';
  tool: { name: string; kind: string };
  enabled: readonly OutputFormatterName[];
}): FormattedOutput['formatter'] | undefined => {
  const { output, status, tool, enabled } = input;
  if (tool.name === GREP_TOOL && enabled.includes('grep')) return 'grep';
  if (enabled.includes('json') && status === 'completed' && parsesAsJson(output)) return 'json';
  if (enabled.includes('log') && tool.kind === EXECUTE_KIND) return 'log';
  return undefined;
};

export const formatToolOutput = (input: {
  output: string;
  status: 'completed' | 'failed';
  tool: { name: string; kind: string };
  enabled: readonly OutputFormatterName[];
  terms: readonly string[];
  reader: string | undefined;
}): FormattedOutput | undefined => {
  const formatter = selectedFormatter(input);
  if (formatter === undefined) return undefined;
  const { output: raw } = input;
  const formatted =
    formatter === 'grep' ? formatGrep(raw) : formatter === 'json' ? formatJson(raw, input.terms.map(asciiLower)) : formatLog(raw);
  if (formatted === undefined) return undefined;
  if (formattingViolations({ raw, formatted, handle: '', header: formattedHeader(formatter, HANDLE_PLACEHOLDER, input.reader), formatter }).length > 0) return undefined;
  return { output: formatted, formatter, version: FORMATTER_VERSIONS[formatter] };
};
