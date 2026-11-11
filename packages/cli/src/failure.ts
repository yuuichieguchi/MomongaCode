import { escapedLines } from './terminal-writer.ts';
import { AUTO_MODE_UNAVAILABLE } from '@momonga/protocol';

const stringField = (error: object, name: string): string | undefined => {
  const value: unknown = Object.getOwnPropertyDescriptor(error, name)?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

export const FAILURE_DETAIL_LINE = '  detail: ';
export const FAILURE_REMEDY_LINE = '  remedy: ';

export const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return escapedLines([String(error)]);
  if (stringField(error, 'code') === AUTO_MODE_UNAVAILABLE.code) return escapedLines([`permission mode unavailable: ${stringField(error, 'reason') ?? error.message}`]);
  const detail = stringField(error, 'detail');
  const remediation = stringField(error, 'remediation');
  return escapedLines([error.message, ...(detail === undefined ? [] : [`${FAILURE_DETAIL_LINE}${detail}`]), ...(remediation === undefined ? [] : [`${FAILURE_REMEDY_LINE}${remediation}`])]);
};
