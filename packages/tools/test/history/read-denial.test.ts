import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ruleEnforcementOf } from '@momonga/foundation';
import { parseRule } from '@momonga/policy';
import { createReadDenial } from '@momonga/tools';
import { makeHarness } from '../harness.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

const setup = async (specifier: string) => {
  const { layout } = makeHarness();
  const { project, home } = layout;
  const rule = parseRule(`Read(${specifier})`, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
  return { project, denied: await createReadDenial({ signal: NEVER_CANCELLED, rules: [rule], roots: [project], cwd: project, enforcement: ruleEnforcementOf('none') }) };
};

describe('read denial follows the enforcement of the sandbox that runs the session', () => {
  const withException = () => {
    const { layout } = makeHarness();
    const { project, home } = layout;
    const rule = parseRule('Read(*.env)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
    return { project, rules: [{ ...rule, exceptions: ['sample.env'] } as typeof rule] };
  };

  it.runIf(process.platform === 'linux')('compiles a rule with an exception when the sandbox enforces exact paths, and refuses it for a Seatbelt profile, on a case-sensitive volume', async () => {
    const { project, rules } = withException();
    await expect((async () => { await await createReadDenial({ signal: NEVER_CANCELLED, rules, roots: [project], cwd: project, enforcement: 'exact-paths' }); })()).resolves.toBeUndefined();
    await expect(createReadDenial({ signal: NEVER_CANCELLED, rules, roots: [project], cwd: project, enforcement: 'seatbelt-profile' })).rejects.toThrow(expect.objectContaining({ code: 'kernel_not_exact' }));
  });
});

describe('read denial of a recorded path', () => {
  it('denies the file a rule names and what lies below a denied directory', async () => {
    const { project, denied } = await setup('./secrets/**');
    expect(denied(path.join(project, 'secrets', 'key.txt'))).toBe(true);
    expect(denied(path.join(project, 'open', 'a.txt'))).toBe(false);
  });

  it('denies a recorded directory that contains a denied target, as a search of that directory read it', async () => {
    const { project, denied } = await setup('./secrets/key.txt');
    expect(denied(path.join(project, 'secrets'))).toBe(true);
    expect(denied(project)).toBe(true);
    expect(denied(path.join(project, 'open'))).toBe(false);
  });

  it('resolves a relative recorded path against the project it was recorded in', async () => {
    const { denied } = await setup('./secrets/key.txt');
    expect(denied('secrets/key.txt')).toBe(true);
    expect(denied('.')).toBe(true);
    expect(denied('open/a.txt')).toBe(false);
  });
});
