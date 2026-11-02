import { describe, expect, it } from 'vitest';
import { createSkillLoader, SkillActivationError, UnknownSkillError } from '@momonga/skills';
import type { SkillLimits } from '@momonga/skills';
import { fakeSkillFileSystem, skillFile } from './fake-file-system.ts';

const HOME = '/home/u';
const PROJECT = '/work/app';
const PDF = `${HOME}/.agents/skills/pdf`;

const loadFrom = async (files: Record<string, string>, limits?: SkillLimits) => {
  const fileSystem = fakeSkillFileSystem(files);
  const set = await createSkillLoader({ home: HOME, fileSystem, ...(limits === undefined ? {} : { limits }) }).load({ projectRoot: PROJECT, trusted: true });
  return { set, fileSystem };
};

const pdfFiles = {
  [`${PDF}/SKILL.md`]: skillFile('pdf', 'Extract PDF text', '# PDF\n\nRun scripts/extract.py'),
  [`${PDF}/scripts/extract.py`]: 'print("SECRET-SCRIPT-BODY")',
  [`${PDF}/references/guide.md`]: 'SECRET-GUIDE-BODY',
};

describe('catalog', () => {
  it('lists name and description of every skill with the activation instructions', async () => {
    const { set } = await loadFrom({ ...pdfFiles, [`${HOME}/.agents/skills/zip/SKILL.md`]: skillFile('zip', 'Pack <files> & folders') });
    expect(set.catalog).toBe(
      [
        'The following skills provide specialized instructions for specific tasks.',
        "When a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions.",
        '',
        '<available_skills>',
        '  <skill>',
        '    <name>pdf</name>',
        '    <description>Extract PDF text</description>',
        '  </skill>',
        '  <skill>',
        '    <name>zip</name>',
        '    <description>Pack &lt;files&gt; &amp; folders</description>',
        '  </skill>',
        '</available_skills>',
      ].join('\n'),
    );
  });

  it('puts a multi-line description on one line', async () => {
    const { set } = await loadFrom({ [`${PDF}/SKILL.md`]: '---\nname: pdf\ndescription: |\n  first line\n  second line\n---\nBody' });
    expect(set.catalog).toContain('<description>first line second line</description>');
  });

  it('is absent without skills', async () => {
    expect((await loadFrom({})).set.catalog).toBeUndefined();
  });

  it('never carries a body or a resource', async () => {
    const { set } = await loadFrom(pdfFiles);
    expect(set.catalog).not.toContain('Run scripts');
    expect(set.catalog).not.toContain('extract.py');
  });
});

describe('activate', () => {
  it('wraps the body without frontmatter and lists the resources without reading them', async () => {
    const { set, fileSystem } = await loadFrom(pdfFiles);
    fileSystem.reads.length = 0;
    const activation = await set.activate('pdf');
    expect(activation.name).toBe('pdf');
    expect(activation.content).toBe(
      [
        '<skill_content name="pdf">',
        '# PDF',
        '',
        'Run scripts/extract.py',
        '',
        `Skill directory: ${PDF}`,
        'Relative paths in this skill are relative to the skill directory.',
        '',
        '<skill_resources>',
        '  <file>references/guide.md</file>',
        '  <file>scripts/extract.py</file>',
        '</skill_resources>',
        '</skill_content>',
      ].join('\n'),
    );
    expect(activation.content).not.toContain('SECRET-');
    expect(fileSystem.reads).toEqual([`${PDF}/SKILL.md`]);
  });

  it('omits the resources block for a skill that is only a SKILL.md', async () => {
    const { set } = await loadFrom({ [`${PDF}/SKILL.md`]: skillFile('pdf', 'Extract') });
    expect((await set.activate('pdf')).content).not.toContain('skill_resources');
  });

  it('escapes the name attribute', async () => {
    const { set } = await loadFrom({ [`${HOME}/.agents/skills/x/SKILL.md`]: skillFile('a&b<c', 'Odd') });
    expect((await set.activate('a&b<c')).content.startsWith('<skill_content name="a&amp;b&lt;c">')).toBe(true);
  });

  it('caps the resource list and marks it incomplete', async () => {
    const { set } = await loadFrom({ ...pdfFiles, [`${PDF}/references/more.md`]: 'x' }, { maxDepth: 4, maxDirectories: 2000, maxResources: 2 });
    const { content } = await set.activate('pdf');
    expect(content).toContain('<skill_resources complete="false">');
    expect(content.match(/<file>/g)).toHaveLength(2);
  });

  it('does not mark a list incomplete when it fits exactly', async () => {
    const { set } = await loadFrom(pdfFiles, { maxDepth: 4, maxDirectories: 2000, maxResources: 2 });
    const { content } = await set.activate('pdf');
    expect(content).toContain('<skill_resources>');
  });

  it('bounds the resource walk by depth and directories and skips .git and node_modules', async () => {
    const { set } = await loadFrom({
      [`${PDF}/SKILL.md`]: skillFile('pdf', 'Extract'),
      [`${PDF}/a/b/deep.txt`]: 'x',
      [`${PDF}/.git/config`]: 'x',
      [`${PDF}/node_modules/dep/index.js`]: 'x',
      [`${PDF}/top.txt`]: 'x',
    }, { maxDepth: 1, maxDirectories: 2000, maxResources: 100 });
    const { content } = await set.activate('pdf');
    expect(content).toContain('<file>top.txt</file>');
    expect(content).not.toContain('deep.txt');
    expect(content).not.toContain('.git');
    expect(content).not.toContain('node_modules');
  });

  it('stops the scan at the directory limit and warns', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`${HOME}/.agents/skills/s${index}/SKILL.md`, skillFile(`s${index}`, 'x')]));
    const { set } = await loadFrom(files, { maxDepth: 4, maxDirectories: 3, maxResources: 100 });
    expect(set.skills.length).toBeLessThan(6);
    expect(set.warnings).toEqual([`Skill scan of ${HOME}/.agents/skills stopped after 3 directories; skills beyond that point were not loaded`]);
  });

  it('reads the file again so that later edits are picked up', async () => {
    const { set, fileSystem } = await loadFrom(pdfFiles);
    fileSystem.set(`${PDF}/SKILL.md`, skillFile('pdf', 'Extract PDF text', 'Changed body'));
    expect((await set.activate('pdf')).content).toContain('Changed body');
  });

  it('rejects an unknown skill naming the available ones', async () => {
    const { set } = await loadFrom(pdfFiles);
    await expect(set.activate('nope')).rejects.toThrow(UnknownSkillError);
    await expect(set.activate('nope')).rejects.toThrow('available skills: pdf');
  });

  it('fails when the file disappeared since the scan', async () => {
    const { set, fileSystem } = await loadFrom(pdfFiles);
    fileSystem.remove(`${PDF}/SKILL.md`);
    await expect(set.activate('pdf')).rejects.toThrow(SkillActivationError);
  });

  it('fails when the file became unreadable since the scan', async () => {
    const { set, fileSystem } = await loadFrom(pdfFiles);
    fileSystem.set(`${PDF}/SKILL.md`, 'no frontmatter any more');
    await expect(set.activate('pdf')).rejects.toThrow('can no longer be read');
  });
});
