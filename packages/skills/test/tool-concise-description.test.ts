import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '@momonga/tools';
import type { ToolSet } from '@momonga/tools';
import { ACTIVATE_SKILL_TOOL_NAME, createSkillLoader } from '@momonga/skills';
import { fakeSkillFileSystem, skillFile } from './fake-file-system.ts';

const HOME = '/home/u';

const activationToolSet = async (): Promise<ToolSet> => {
  const fileSystem = fakeSkillFileSystem({ [`${HOME}/.agents/skills/pdf/SKILL.md`]: skillFile('pdf', 'Extract PDF text') });
  const set = await createSkillLoader({ home: HOME, fileSystem }).load({ projectRoot: '/work/app', trusted: true, signal: new AbortController().signal });
  const tool = set.activationTool({ isActive: () => false, admit: async () => ({ admitted: true }) });
  if (tool === undefined) throw new Error('expected an activation tool');
  const registry = createToolRegistry();
  registry.register(tool);
  return registry.snapshot();
};

const descriptionFor = (set: ToolSet, conciseDescriptions: boolean): string => {
  const options = { mode: 'manual', rules: [], conciseDescriptions } as Parameters<ToolSet['forModel']>[0];
  const tool = set.forModel(options).find((entry) => entry.name === ACTIVATE_SKILL_TOOL_NAME);
  if (tool === undefined) throw new Error('the activation tool is not offered');
  return tool.description ?? '';
};

describe('activate_skill concise description (T3-6)', () => {
  it('offers a non-empty concise description strictly shorter than the full one', async () => {
    const set = await activationToolSet();
    const full = descriptionFor(set, false);
    const concise = descriptionFor(set, true);
    expect(full).toBe(set.get(ACTIVATE_SKILL_TOOL_NAME)?.description);
    expect(concise.trim().length).toBeGreaterThan(0);
    expect(concise.length).toBeLessThan(full.length);
  });
});
