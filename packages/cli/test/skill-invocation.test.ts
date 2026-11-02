import { describe, expect, it } from 'vitest';
import type { SkillView } from '@momonga/protocol';
import { SkillInvocationError, resolveSkillInvocation } from '../src/run/skill-invocation.ts';

const PDF: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/p/SKILL.md' };

const client = (skills: SkillView[]) => ({
  calls: [] as string[],
  skills: async function (this: { calls: string[] }, sessionId: string) {
    this.calls.push(sessionId);
    return { skills, warnings: [] };
  },
});

describe('resolveSkillInvocation', () => {
  it('runs a slash prompt that names a listed skill with the rest of the line as the task', async () => {
    expect(await resolveSkillInvocation(client([PDF]), 's1', '/pdf summarize it', undefined)).toEqual({ input: 'summarize it', skill: 'pdf' });
  });

  it('sends a slash prompt that names no skill as the plain text it is', async () => {
    expect(await resolveSkillInvocation(client([PDF]), 's1', '/etc/hosts what is this', undefined)).toEqual({ input: '/etc/hosts what is this' });
  });

  it('does not list skills for a prompt that is not a slash command', async () => {
    const fake = client([PDF]);
    expect(await resolveSkillInvocation(fake, 's1', 'summarize it', undefined)).toEqual({ input: 'summarize it' });
    expect(fake.calls).toEqual([]);
  });

  it('uses the explicit skill with the whole prompt as the task and refuses an unknown skill', async () => {
    expect(await resolveSkillInvocation(client([PDF]), 's1', '/etc/hosts', 'pdf')).toEqual({ input: '/etc/hosts', skill: 'pdf' });
    await expect(resolveSkillInvocation(client([PDF]), 's1', 'x', 'zip')).rejects.toThrow('no skill named zip; available: pdf');
  });

  it('asks for a task instead of inventing one', async () => {
    await expect(resolveSkillInvocation(client([PDF]), 's1', '/pdf', undefined)).rejects.toBeInstanceOf(SkillInvocationError);
  });
});
