import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import { SandboxPolicyError } from '@momonga/sandbox';
import { buildSandboxPolicy } from '@momonga/tools';
import type { SandboxPolicyOptions } from '@momonga/tools';
import { makeLayout } from '../helpers.ts';

const optionsFor = () => {
  const layout = makeLayout();
  const sessions = path.join(layout.root, 'sessions');
  const tmpDir = path.join(sessions, 's');
  fs.mkdirSync(tmpDir, { recursive: true });
  const rule = parseRule('Read(.env)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project });
  const fileRules = computeFileRules([rule], [layout.project], tmpDir);
  const options: SandboxPolicyOptions = { roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, fileRules, protectedSet: EMPTY_PROTECTED_SET };
  return { layout, options, fileRules };
};

const codeOf = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPolicyError);
    return (error as SandboxPolicyError).code;
  }
  throw new Error('expected a SandboxPolicyError');
};

describe('buildSandboxPolicy and file rules', () => {
  it('keeps the given fileRules', () => {
    const { options, fileRules } = optionsFor();
    expect((buildSandboxPolicy(options) as { fileRules?: unknown }).fileRules).toBe(fileRules);
  });

  it.each(['extraReadDenied', 'extraWritable', 'readAllowed'] as const)('throws entry_not_absolute for a relative %s entry', (field) => {
    const { options } = optionsFor();
    expect(codeOf(() => buildSandboxPolicy({ ...options, [field]: ['relative-entry'] }))).toBe('entry_not_absolute');
  });

  it('throws writable_root_not_absolute for a relative root', () => {
    const { options } = optionsFor();
    expect(codeOf(() => buildSandboxPolicy({ ...options, roots: ['relative-root'] }))).toBe('writable_root_not_absolute');
  });

  it('throws read_allowed_inside_owned_root for a readAllowed entry inside home/.momonga', () => {
    const { layout, options } = optionsFor();
    const inside = path.join(layout.home, '.momonga', 'projects');
    fs.mkdirSync(inside, { recursive: true });
    expect(codeOf(() => buildSandboxPolicy({ ...options, readAllowed: [inside] }))).toBe('read_allowed_inside_owned_root');
  });

  it('accepts a readAllowed entry inside the skills directory of home/.momonga', () => {
    const { layout, options } = optionsFor();
    const skill = path.join(layout.home, '.momonga', 'skills', 'pdf');
    fs.mkdirSync(skill, { recursive: true });
    const policy = buildSandboxPolicy({ ...options, readAllowed: [skill] });
    expect(policy.readAllowed).toContain(skill);
    expect(policy.readDenied).toContain(path.join(layout.home, '.momonga'));
  });

  it('still throws read_allowed_inside_owned_root for the owned root next to the skills directory', () => {
    const { layout, options } = optionsFor();
    const sibling = path.join(layout.home, '.momonga', 'skills-state');
    fs.mkdirSync(sibling, { recursive: true });
    expect(codeOf(() => buildSandboxPolicy({ ...options, readAllowed: [sibling] }))).toBe('read_allowed_inside_owned_root');
  });

  it('throws read_allowed_not_inside_denied for a readAllowed entry outside every readDenied entry', () => {
    const { layout, options } = optionsFor();
    expect(codeOf(() => buildSandboxPolicy({ ...options, readAllowed: [layout.outside] }))).toBe('read_allowed_not_inside_denied');
  });
});
