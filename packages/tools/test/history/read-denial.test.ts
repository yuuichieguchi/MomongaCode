import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRule } from '@momonga/policy';
import { createReadDenial } from '@momonga/tools';
import { makeHarness } from '../harness.ts';

const setup = (specifier: string) => {
  const { layout } = makeHarness();
  const { project, home } = layout;
  const rule = parseRule(`Read(${specifier})`, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
  return { project, denied: createReadDenial({ rules: [rule], roots: [project], cwd: project }) };
};

describe('read denial of a recorded path', () => {
  it('denies the file a rule names and what lies below a denied directory', () => {
    const { project, denied } = setup('./secrets/**');
    expect(denied(path.join(project, 'secrets', 'key.txt'))).toBe(true);
    expect(denied(path.join(project, 'open', 'a.txt'))).toBe(false);
  });

  it('denies a recorded directory that contains a denied target, as a search of that directory read it', () => {
    const { project, denied } = setup('./secrets/key.txt');
    expect(denied(path.join(project, 'secrets'))).toBe(true);
    expect(denied(project)).toBe(true);
    expect(denied(path.join(project, 'open'))).toBe(false);
  });

  it('resolves a relative recorded path against the project it was recorded in', () => {
    const { denied } = setup('./secrets/key.txt');
    expect(denied('secrets/key.txt')).toBe(true);
    expect(denied('.')).toBe(true);
    expect(denied('open/a.txt')).toBe(false);
  });
});
