import { describe, expect, it } from 'vitest';
import { ToolExecutionError, createToolRegistry, validateToolInput } from '@momonga/tools';
import type { AnyTool, ToolContext, ToolResult } from '@momonga/tools';
import { ACTIVATE_SKILL_TOOL_NAME, createSkillLoader } from '@momonga/skills';
import { fakeSkillFileSystem, skillFile } from './fake-file-system.ts';

const HOME = '/home/u';
const files = {
  [`${HOME}/.agents/skills/pdf/SKILL.md`]: skillFile('pdf', 'Extract PDF text'),
  [`${HOME}/.agents/skills/zip/SKILL.md`]: skillFile('zip', 'Pack files'),
};

const toolOf = async (isActive: (name: string) => boolean = () => false, fileSystem = fakeSkillFileSystem(files)): Promise<AnyTool> => {
  const set = await createSkillLoader({ home: HOME, fileSystem }).load({ projectRoot: '/work/app', trusted: true });
  const tool = set.activationTool({ isActive });
  if (tool === undefined) throw new Error('expected an activation tool');
  return tool;
};

const run = async (tool: AnyTool, name: string): Promise<ToolResult> => {
  const result = await tool.execute({ name }, {} as ToolContext, undefined);
  if (result.status === 'pending') throw new Error('activate_skill must not wait');
  return result;
};

describe('activate_skill tool', () => {
  it('is named activate_skill and constrains name to the catalog as an enum', async () => {
    const tool = await toolOf();
    expect(tool.name).toBe(ACTIVATE_SKILL_TOOL_NAME);
    expect(tool.inputSchema).toMatchObject({ properties: { name: { type: 'string', enum: ['pdf', 'zip'] } }, required: ['name'], additionalProperties: false });
    expect(validateToolInput(tool, { name: 'pdf' }).ok).toBe(true);
    expect(validateToolInput(tool, { name: 'invented' }).ok).toBe(false);
    expect(validateToolInput(tool, {}).ok).toBe(false);
  });

  it('is a read-only tool without a permission subject so that it never asks', async () => {
    const tool = await toolOf();
    expect(tool).toMatchObject({ kind: 'read', sideEffect: 'read_only' });
    expect(tool.subject({ name: 'pdf' }, { cwd: '/work/app', home: HOME, roots: ['/work/app'] })).toEqual({ kind: 'none', tool: 'activate_skill' });
  });

  it('registers in the tool registry', async () => {
    const registry = createToolRegistry();
    registry.register(await toolOf());
    expect((await registry.snapshot()).get('activate_skill')).toBeDefined();
  });

  it('is not offered without skills', async () => {
    const set = await createSkillLoader({ home: HOME, fileSystem: fakeSkillFileSystem({}) }).load({ projectRoot: '/work/app', trusted: true });
    expect(set.activationTool({ isActive: () => false })).toBeUndefined();
  });

  it('returns the wrapped body and the activation to protect', async () => {
    const result = await run(await toolOf(), 'pdf');
    expect(result.status).toBe('completed');
    expect(result.output.startsWith('<skill_content name="pdf">')).toBe(true);
    expect(result.skill).toEqual({ name: 'pdf', content: result.output });
  });

  it('does not activate a skill twice within one claim', async () => {
    const tool = await toolOf();
    const first = await run(tool, 'pdf');
    const second = await run(tool, 'pdf');
    expect(first.skill).toBeDefined();
    expect(second.skill).toBeUndefined();
    expect(second.output).toBe('Skill pdf is already active; its instructions are already in your context.');
  });

  it('does not activate two parallel requests for the same skill twice', async () => {
    const tool = await toolOf();
    const results = await Promise.all([run(tool, 'pdf'), run(tool, 'pdf')]);
    expect(results.filter((result) => result.skill !== undefined)).toHaveLength(1);
  });

  it('does not activate a skill the run already holds', async () => {
    const result = await run(await toolOf((name) => name === 'pdf'), 'pdf');
    expect(result.skill).toBeUndefined();
    expect(result.output).toContain('already active');
  });

  it('activates another skill independently', async () => {
    const tool = await toolOf();
    await run(tool, 'pdf');
    expect((await run(tool, 'zip')).skill?.name).toBe('zip');
  });

  it('reports a vanished file as a tool failure and allows a retry', async () => {
    const fileSystem = fakeSkillFileSystem(files);
    const tool = await toolOf(() => false, fileSystem);
    fileSystem.remove(`${HOME}/.agents/skills/pdf/SKILL.md`);
    await expect(run(tool, 'pdf')).rejects.toThrow(ToolExecutionError);
    fileSystem.set(`${HOME}/.agents/skills/pdf/SKILL.md`, skillFile('pdf', 'Extract PDF text'));
    expect((await run(tool, 'pdf')).skill?.name).toBe('pdf');
  });
});
