import type { SkillScope } from '@momonga/protocol';
import type { AnyTool } from '@momonga/tools';

export type Skill = {
  name: string;
  description: string;
  scope: SkillScope;
  location: string;
  directory: string;
  realDirectory: string;
};

export type SkillContent = { name: string; content: string };

export type ActivationToolOptions = { isActive(name: string): boolean };

export type SkillSet = {
  skills: readonly Skill[];
  warnings: readonly string[];
  readDirectories: readonly string[];
  catalog: string | undefined;
  activate(name: string): Promise<SkillContent>;
  activationTool(options: ActivationToolOptions): AnyTool | undefined;
};

export type SkillLoadRequest = { projectRoot: string; trusted: boolean };

export type SkillLoader = { load(request: SkillLoadRequest): Promise<SkillSet> };

export class SkillActivationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SkillActivationError';
  }
}

export class UnknownSkillError extends Error {
  readonly skill: string;

  constructor(skill: string, available: readonly string[]) {
    super(`unknown skill ${JSON.stringify(skill)}; available skills: ${available.length === 0 ? 'none' : available.join(', ')}`);
    this.name = 'UnknownSkillError';
    this.skill = skill;
  }
}
