import { describe, expect, it, vi } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { formatJson, formatToolOutput } from '@momonga/context';

const DEFECTIVE = '{"defect": true}';
const defect = new TypeError('the parser broke');

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...original,
    parseOutsideJson: (text: string): unknown => {
      if (text === DEFECTIVE) throw defect;
      return original.parseOutsideJson(text);
    },
  };
});

const deep = `${'['.repeat(MAX_JSON_DEPTH + 2)}${']'.repeat(MAX_JSON_DEPTH + 2)}`;

describe('the json formatter declines only what is not JSON it may read', () => {
  it('declines a syntax error and a nesting deeper than the JSON depth rule', () => {
    expect(formatJson('{ not json', [])).toBeUndefined();
    expect(formatJson(deep, [])).toBeUndefined();
    expect(formatToolOutput({ output: deep, status: 'completed', tool: { name: 'Bash', kind: 'other' }, enabled: ['json'], terms: [], reader: undefined })).toBeUndefined();
  });

  it('lets any other failure of the parse reach the caller', () => {
    expect(() => formatJson(DEFECTIVE, [])).toThrow(defect);
    expect(() => formatToolOutput({ output: DEFECTIVE, status: 'completed', tool: { name: 'Bash', kind: 'other' }, enabled: ['json'], terms: [], reader: undefined })).toThrow(defect);
  });
});
