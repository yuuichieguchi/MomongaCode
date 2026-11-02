import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_RULE_ENFORCEMENT } from '@momonga/foundation';
import { parseRule } from '@momonga/policy';
import { createReadDenial } from '@momonga/tools';
import { makeHarness } from '../harness.ts';

const setup = (specifier: string) => {
  const { layout } = makeHarness();
  const { project, home } = layout;
  const rule = parseRule(`Read(${specifier})`, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
  return { project, denied: createReadDenial({ rules: [rule], roots: [project], cwd: project, enforcement: HOST_RULE_ENFORCEMENT }) };
};

describe('read denial follows the enforcement of the sandbox that runs the session', () => {
  const withException = () => {
    const { layout } = makeHarness();
    const { project, home } = layout;
    const rule = parseRule('Read(*.env)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
    return { project, rules: [{ ...rule, exceptions: ['sample.env'] } as typeof rule] };
  };

  it.runIf(process.platform === 'linux')('compiles a rule with an exception when the sandbox enforces exact paths, and refuses it for a Seatbelt profile, on a case-sensitive volume', () => {
    const { project, rules } = withException();
    expect(() => createReadDenial({ rules, roots: [project], cwd: project, enforcement: 'exact-paths' })).not.toThrow();
    expect(() => createReadDenial({ rules, roots: [project], cwd: project, enforcement: 'seatbelt-profile' })).toThrow(expect.objectContaining({ code: 'kernel_not_exact' }));
  });
});

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
