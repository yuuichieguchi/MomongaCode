import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillLoader, createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createSkillsPort } from '@momonga/runtime';
import type { Session } from '@momonga/store';
import { NEVER_CANCELLED } from '@momonga/testkit';

const roots: string[] = [];

const tempRoot = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crafted-load-')));
  roots.push(root);
  return root;
};

const locked: string[] = [];

const lock = (target: string): void => {
  fs.chmodSync(target, 0o000);
  locked.push(target);
};

afterEach(() => {
  for (const target of locked.splice(0)) fs.chmodSync(target, 0o700);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const ALIAS_BOMB = [
  'a: &a [x, x, x, x, x, x, x, x, x, x]',
  'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
  'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
  'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
  'e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]',
].join('\n');

const sessionAt = (cwd: string): Session => ({
  id: 'session',
  cwd,
  env: {},
  permissionMode: 'manual',
  model: 'model',
  bypassAllowed: false,
  sandboxNetwork: null,
  additionalDirectories: [],
  mcpServers: {},
  createdAt: 0,
});

const workspace = (): { home: string; project: string } => {
  const root = tempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  return { home, project };
};

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const skillPortFor = (home: string) =>
  createSkillsPort({ loader: createSkillLoader({ home, fileSystem: createNodeSkillFileSystem() }), settings: { trusted: async () => true } });

const agentPortFor = (home: string) =>
  createAgentsPort({
    home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: async () => true },
    runs: {
      spawn: () => Promise.reject(new Error('no child runs in this test')),
      outcomeOf: () => {
        throw new Error('no child runs in this test');
      },
    },
  });

const goodSkill = (name: string): string => `---\nname: ${name}\ndescription: A good skill\n---\nBody\n`;
const goodAgent = (name: string): string => `---\nname: ${name}\ndescription: A good agent\n---\nWork.\n`;

describe('the runtime skill load path with crafted files', () => {
  it('skips a SKILL.md whose YAML is a model bomb, warns about it and still loads its sibling', async () => {
    const { home, project } = workspace();
    write(path.join(project, '.momonga', 'skills', 'bomb', 'SKILL.md'), `---\nname: bomb\ndescription: Bomb\n${ALIAS_BOMB}\n---\nBody\n`);
    write(path.join(project, '.momonga', 'skills', 'good', 'SKILL.md'), goodSkill('good'));
    const set = await skillPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.skills.map((skill) => skill.name)).toEqual(['good']);
    expect(set.warnings.join('\n')).toMatch(/bomb.*SKILL\.md was skipped: the frontmatter is not valid YAML/);
  });

  it('survives a directory symlink that points at itself and still loads its sibling', async () => {
    const { home, project } = workspace();
    const skills = path.join(project, '.momonga', 'skills');
    write(path.join(skills, 'good', 'SKILL.md'), goodSkill('good'));
    fs.symlinkSync(path.join(skills, 'loop'), path.join(skills, 'loop'));
    const set = await skillPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.skills.map((skill) => skill.name)).toEqual(['good']);
  });

  it('survives a SKILL.md that is a symlink loop and still loads its sibling', async () => {
    const { home, project } = workspace();
    const skills = path.join(project, '.momonga', 'skills');
    write(path.join(skills, 'good', 'SKILL.md'), goodSkill('good'));
    fs.mkdirSync(path.join(skills, 'looping'));
    fs.symlinkSync(path.join(skills, 'looping', 'SKILL.md'), path.join(skills, 'looping', 'SKILL.md'));
    const set = await skillPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.skills.map((skill) => skill.name)).toEqual(['good']);
  });

  it('reports an unreadable skill directory and an unreadable SKILL.md and still loads the others', async () => {
    const { home, project } = workspace();
    const skills = path.join(project, '.momonga', 'skills');
    write(path.join(skills, 'good', 'SKILL.md'), goodSkill('good'));
    write(path.join(skills, 'locked-file', 'SKILL.md'), goodSkill('locked-file'));
    lock(path.join(skills, 'locked-file', 'SKILL.md'));
    fs.mkdirSync(path.join(skills, 'locked-dir'));
    lock(path.join(skills, 'locked-dir'));
    const set = await skillPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.skills.map((skill) => skill.name)).toEqual(['good']);
    expect(set.warnings.join('\n')).toContain('EACCES');
  });
});

describe('skill activation with crafted resources', () => {
  it('activates a skill whose resource directory is unreadable and marks the resource list incomplete', async () => {
    const { home, project } = workspace();
    const skill = path.join(project, '.momonga', 'skills', 'good');
    write(path.join(skill, 'SKILL.md'), goodSkill('good'));
    write(path.join(skill, 'notes', 'a.txt'), 'a');
    fs.mkdirSync(path.join(skill, 'secret'));
    lock(path.join(skill, 'secret'));
    const set = await skillPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    const activated = await set.activate('good');
    expect(activated.content).toContain('<skill_resources complete="false">');
    expect(activated.content).toContain('<file>notes/a.txt</file>');
  });
});

describe('the runtime agent load path with crafted files', () => {
  it('skips an agent file whose YAML is a model bomb and still loads its sibling', async () => {
    const { home, project } = workspace();
    const agents = path.join(project, '.momonga', 'agents');
    write(path.join(agents, 'bomb.md'), `---\nname: bomb\ndescription: Bomb\n${ALIAS_BOMB}\n---\nWork.\n`);
    write(path.join(agents, 'good.md'), goodAgent('good'));
    const set = await agentPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.agents.map((agent) => agent.name)).toEqual(['good']);
    expect(set.warnings.join('\n')).toMatch(/bomb\.md was skipped: the frontmatter is not valid YAML/);
  });

  it('skips an agent file that is a symlink loop and an unreadable agent file', async () => {
    const { home, project } = workspace();
    const agents = path.join(project, '.momonga', 'agents');
    write(path.join(agents, 'good.md'), goodAgent('good'));
    fs.symlinkSync(path.join(agents, 'loop.md'), path.join(agents, 'loop.md'));
    write(path.join(agents, 'locked.md'), goodAgent('locked'));
    lock(path.join(agents, 'locked.md'));
    const set = await agentPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.agents.map((agent) => agent.name)).toEqual(['good']);
    expect(set.warnings.join('\n')).toContain('locked.md');
  });

  it('reports an unreadable agents directory instead of failing the load', async () => {
    const { home, project } = workspace();
    const agents = path.join(project, '.momonga', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    lock(agents);
    const set = await agentPortFor(home).load(sessionAt(project), NEVER_CANCELLED);
    expect(set.agents).toEqual([]);
    expect(set.warnings.join('\n')).toContain('EACCES');
  });
});
