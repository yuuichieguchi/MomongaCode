import { PinnedOverflowError, PinnedRoomError } from '@momonga/context';
import type { ActivatedSkill } from '@momonga/context';
import type { SkillAdmission, SkillContent } from '@momonga/skills';
import type { ClaimContext } from './claim-context.ts';
import { measureLayersWith } from './context-step.ts';

const ADVICE = 'Continue without it or use a model with a larger context window.';

const rejectionOf = (name: string, error: PinnedOverflowError): string =>
  error instanceof PinnedRoomError
    ? `Skill ${name} was not activated: with its instructions the pinned context would take ${error.pinnedTokens} of at most ${error.ceiling} tokens and leave ${error.room} for the conversation, but at least ${error.minimum} are needed. ${ADVICE}`
    : `Skill ${name} was not activated: its instructions do not fit the context window (the pinned context would need ${error.pinnedTokens} tokens but at most ${error.ceiling} fit). ${ADVICE}`;

const settled = (): undefined => undefined;

export const createSkillAdmission = (contextOf: () => ClaimContext): ((skill: SkillContent) => Promise<SkillAdmission>) => {
  const granted = new Map<string, ActivatedSkill>();
  let queue: Promise<unknown> = Promise.resolve();

  const check = async (skill: SkillContent): Promise<SkillAdmission> => {
    const ctx = contextOf();
    const held = new Map<string, ActivatedSkill>();
    for (const entry of [...ctx.journal.state.activatedSkills, ...granted.values(), skill]) {
      if (!held.has(entry.name)) held.set(entry.name, entry);
    }
    try {
      await measureLayersWith(ctx, [...held.values()]);
    } catch (error) {
      if (error instanceof PinnedOverflowError) return { admitted: false, reason: rejectionOf(skill.name, error) };
      throw error;
    }
    granted.set(skill.name, skill);
    return { admitted: true };
  };

  return (skill) => {
    const result = queue.then(() => check(skill));
    queue = result.then(settled, settled);
    return result;
  };
};
