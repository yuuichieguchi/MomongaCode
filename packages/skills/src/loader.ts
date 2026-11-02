import { activateSkill } from './activation.ts';
import { DEFAULT_SKILL_LIMITS } from './constants.ts';
import type { SkillLimits } from './constants.ts';
import { renderCatalog } from './catalog.ts';
import type { SkillFileSystem } from './file-system.ts';
import { scanSkills } from './scan.ts';
import { createActivateSkillTool } from './tool.ts';
import { UnknownSkillError } from './types.ts';
import type { Skill, SkillLoader, SkillSet } from './types.ts';

export type SkillLoaderOptions = { home: string; fileSystem: SkillFileSystem; limits?: SkillLimits };

export const createSkillLoader = ({ home, fileSystem, limits = DEFAULT_SKILL_LIMITS }: SkillLoaderOptions): SkillLoader => ({
  load: async ({ projectRoot, trusted }) => {
    const { skills, warnings } = await scanSkills({ home, projectRoot, trusted }, fileSystem, limits);
    const byName = new Map<string, Skill>(skills.map((skill) => [skill.name, skill]));
    const activate: SkillSet['activate'] = (name) => {
      const skill = byName.get(name);
      if (skill === undefined) throw new UnknownSkillError(name, skills.map((entry) => entry.name));
      return activateSkill(skill, fileSystem, limits);
    };
    const activationTool: SkillSet['activationTool'] = ({ isActive, admit }) =>
      skills.length === 0 ? undefined : createActivateSkillTool({ skills, activate, isActive, admit });
    return {
      skills,
      warnings,
      readDirectories: [...new Set(skills.map((skill) => skill.realDirectory))],
      catalog: renderCatalog(skills),
      activate: async (name) => activate(name),
      activationTool,
      recoveryTool: () =>
        activationTool({
          isActive: () => false,
          admit: () => Promise.reject(new Error('the recovery tool describes activate_skill for reconciliation and never executes it')),
        }),
    };
  },
});
