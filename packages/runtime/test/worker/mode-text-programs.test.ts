import { describe, expect, it } from 'vitest';
import { commandSpecsFor } from '@momonga/policy';
import { MODE_RULE } from './inheritance-support.ts';

const listed = (text: string, pattern: RegExp): string[] => {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`no program list in: ${text}`);
  return (match[1] as string)
    .split(/, | and /)
    .map((name) => name.replace(/^read-only /, '').replace(/ on Linux$/, '').trim())
    .filter((name) => name !== '');
};

const READ_ONLY_LIST = /\(([^)]*)\)/;
const EDIT_LIST = /filesystem commands (.*?) inside the workspace/;

describe('model-facing mode texts name exactly the approvable programs (3.12)', () => {
  it('names the read-only set in the default and plan texts and the edit set in the acceptEdits text', () => {
    const approvedOn = (platform: NodeJS.Platform, approval: 'read-only' | 'edit'): string[] =>
      commandSpecsFor(platform).all.filter((model) => model.approval === approval).flatMap((model) => model.names);
    const readOnly = [...new Set([...approvedOn('darwin', 'read-only'), ...approvedOn('linux', 'read-only')])];
    const edit = approvedOn('darwin', 'edit');
    expect(readOnly.length).toBeGreaterThan(0);
    expect(edit.length).toBeGreaterThan(0);
    expect(MODE_RULE.default).toContain('ps on Linux');
    expect(readOnly.filter((name) => !approvedOn('darwin', 'read-only').includes(name))).toEqual(['ps']);
    expect(new Set(listed(MODE_RULE.default, READ_ONLY_LIST))).toEqual(new Set(readOnly));
    expect(new Set(listed(MODE_RULE.plan, READ_ONLY_LIST))).toEqual(new Set(readOnly));
    expect(new Set(listed(MODE_RULE.acceptEdits, EDIT_LIST))).toEqual(new Set(edit));
  });
});
