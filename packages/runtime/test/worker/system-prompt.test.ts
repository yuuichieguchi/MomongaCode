import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { buildSystemPrompt } from '@momonga/runtime';

const CONTEXT = { cwd: '/work/project', platform: 'darwin' };

describe('system prompt', () => {
  it('is byte-stable for the same session context', () => {
    expect(sha256Hex(buildSystemPrompt(CONTEXT))).toBe(sha256Hex(buildSystemPrompt({ ...CONTEXT })));
  });

  it('is filled with the session cwd and platform', () => {
    const prompt = buildSystemPrompt(CONTEXT);
    expect(prompt).toContain('/work/project');
    expect(prompt).toContain('darwin');
    expect(buildSystemPrompt({ ...CONTEXT, cwd: '/work/other' })).not.toBe(prompt);
    expect(buildSystemPrompt({ ...CONTEXT, platform: 'linux' })).not.toBe(prompt);
  });

  it('contains no timestamp or random id', () => {
    const prompt = buildSystemPrompt(CONTEXT);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it('states the role, untrusted data, instruction precedence, ReadOutput, UpdatePlan and concision', () => {
    const prompt = buildSystemPrompt(CONTEXT);
    expect(prompt).toMatch(/coding agent/i);
    expect(prompt).toMatch(/not instructions/i);
    expect(prompt).toMatch(/AGENTS\.md/);
    expect(prompt).toMatch(/ReadOutput/);
    expect(prompt).toMatch(/UpdatePlan/);
    expect(prompt).toMatch(/concise/i);
  });
});
