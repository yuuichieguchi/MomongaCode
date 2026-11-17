import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, ruleEnforcementOf, momongaLayout, standardSecretLocations } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import { SandboxPolicyError } from '@momonga/sandbox';
import { buildSandboxPolicy } from '@momonga/tools';
import type { SandboxPolicyOptions } from '@momonga/tools';
import { makeLayout } from '../helpers.ts';
import { testProbes, NEVER_CANCELLED } from '@momonga/testkit';

const optionsFor = async () => {
  const layout = makeLayout();
  const sessions = path.join(layout.root, 'sessions');
  const tmpDir = path.join(sessions, 's');
  fs.mkdirSync(tmpDir, { recursive: true });
  const rule = parseRule('Read(.env)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project });
  const fileRules = await computeFileRules([rule], [layout.project], tmpDir, ruleEnforcementOf('none'), testProbes());
  const options: SandboxPolicyOptions = { roots: [layout.project], home: layout.home, layout: momongaLayout(layout.home, process.platform, process.env), tmpDir, sessionsTmpRoot: sessions, fileRules, protectedSet: EMPTY_PROTECTED_SET };
  return { layout, options, fileRules };
};

const codeOf = async (action: () => unknown): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPolicyError);
    return (error as SandboxPolicyError).code;
  }
  throw new Error('expected a SandboxPolicyError');
};

describe('buildSandboxPolicy and file rules', () => {
  it('keeps the given fileRules', async () => {
    const { options, fileRules } = await optionsFor();
    expect((await buildSandboxPolicy(options, NEVER_CANCELLED) as { fileRules?: unknown }).fileRules).toBe(fileRules);
  });

  it.each(['extraReadDenied', 'extraWritable', 'readAllowed'] as const)('throws entry_not_absolute for a relative %s entry', async (field) => {
    const { options } = await optionsFor();
    expect(await codeOf(() => buildSandboxPolicy({ ...options, [field]: ['relative-entry'] }, NEVER_CANCELLED))).toBe('entry_not_absolute');
  });

  it('throws writable_root_not_absolute for a relative root', async () => {
    const { options } = await optionsFor();
    expect(await codeOf(() => buildSandboxPolicy({ ...options, roots: ['relative-root'] }, NEVER_CANCELLED))).toBe('writable_root_not_absolute');
  });

  it('throws read_allowed_inside_owned_root for a readAllowed entry inside home/.momonga', async () => {
    const { layout, options } = await optionsFor();
    const inside = path.join(layout.home, '.momonga', 'projects');
    fs.mkdirSync(inside, { recursive: true });
    expect(await codeOf(() => buildSandboxPolicy({ ...options, readAllowed: [inside] }, NEVER_CANCELLED))).toBe('read_allowed_inside_owned_root');
  });

  it('names every secret location the sandbox denies when a readAllowed entry lies inside one', async () => {
    const { layout, options } = await optionsFor();
    const inside = path.join(layout.home, '.momonga', 'projects');
    fs.mkdirSync(inside, { recursive: true });
    const message = await buildSandboxPolicy({ ...options, readAllowed: [inside] }, NEVER_CANCELLED).then(
      () => '',
      (error: unknown) => (error as Error).message,
    );
    for (const location of standardSecretLocations(options.layout)) expect(message).toContain(location.label);
  });

  it('accepts a readAllowed entry inside the skills directory of home/.momonga', async () => {
    const { layout, options } = await optionsFor();
    const skill = path.join(layout.home, '.momonga', 'skills', 'pdf');
    fs.mkdirSync(skill, { recursive: true });
    const policy = await buildSandboxPolicy({ ...options, readAllowed: [skill] }, NEVER_CANCELLED);
    expect(policy.readAllowed).toContain(skill);
    expect(policy.readDenied).toContain(path.join(layout.home, '.momonga'));
  });

  it('still throws read_allowed_inside_owned_root for the owned root next to the skills directory', async () => {
    const { layout, options } = await optionsFor();
    const sibling = path.join(layout.home, '.momonga', 'skills-state');
    fs.mkdirSync(sibling, { recursive: true });
    expect(await codeOf(() => buildSandboxPolicy({ ...options, readAllowed: [sibling] }, NEVER_CANCELLED))).toBe('read_allowed_inside_owned_root');
  });

  it('throws read_allowed_not_inside_denied for a readAllowed entry outside every readDenied entry', async () => {
    const { layout, options } = await optionsFor();
    expect(await codeOf(() => buildSandboxPolicy({ ...options, readAllowed: [layout.outside] }, NEVER_CANCELLED))).toBe('read_allowed_not_inside_denied');
  });
});
