import { describe, expect, it } from 'vitest';
import { COMMAND_SPECS } from '@momonga/policy';
import { MODE_RULE } from './inheritance-support.ts';

const listed = (text: string, pattern: RegExp): string[] => {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`no program list in: ${text}`);
  return (match[1] as string)
    .split(/, | and /)
    .map((name) => name.replace(/^read-only /, '').trim())
    .filter((name) => name !== '');
};

const READ_ONLY_LIST = /\(([^)]*)\)/;
const EDIT_LIST = /filesystem commands (.*?) inside the workspace/;

describe('model-facing mode texts name exactly the approvable programs (3.12)', () => {
  it('names the read-only set in the default and plan texts and the edit set in the acceptEdits text', () => {
    const readOnly = COMMAND_SPECS.filter((model) => model.approval === 'read-only').flatMap((model) => model.names);
    const edit = COMMAND_SPECS.filter((model) => model.approval === 'edit').flatMap((model) => model.names);
    expect(readOnly.length).toBeGreaterThan(0);
    expect(edit.length).toBeGreaterThan(0);
    expect(new Set(listed(MODE_RULE.default, READ_ONLY_LIST))).toEqual(new Set(readOnly));
    expect(new Set(listed(MODE_RULE.plan, READ_ONLY_LIST))).toEqual(new Set(readOnly));
    expect(new Set(listed(MODE_RULE.acceptEdits, EDIT_LIST))).toEqual(new Set(edit));
  });
});
