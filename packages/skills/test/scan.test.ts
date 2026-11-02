import { describe, expect, it } from 'vitest';
import { createSkillLoader } from '@momonga/skills';
import { fakeSkillFileSystem, skillFile } from './fake-file-system.ts';

const HOME = '/home/u';
const PROJECT = '/work/app';

const loadFrom = async (files: Record<string, string>, trusted = true, links: Record<string, string> = {}) => {
  const fileSystem = fakeSkillFileSystem(files, links);
  const set = await createSkillLoader({ home: HOME, fileSystem }).load({ projectRoot: PROJECT, trusted });
  return { set, fileSystem };
};

const namesOf = (set: { skills: readonly { name: string }[] }): string[] => set.skills.map((skill) => skill.name);

describe('skill locations', () => {
  it.each([
    ['project .agents', `${PROJECT}/.agents/skills/alpha/SKILL.md`, 'project'],
    ['project .momonga', `${PROJECT}/.momonga/skills/alpha/SKILL.md`, 'project'],
    ['user .agents', `${HOME}/.agents/skills/alpha/SKILL.md`, 'user'],
    ['user .momonga', `${HOME}/.momonga/skills/alpha/SKILL.md`, 'user'],
  ] as const)('scans %s', async (_label, file, scope) => {
    const { set } = await loadFrom({ [file]: skillFile('alpha', 'Alpha skill') });
    expect(set.skills).toEqual([
      { name: 'alpha', description: 'Alpha skill', scope, location: file, directory: file.replace('/SKILL.md', ''), realDirectory: file.replace('/SKILL.md', '') },
    ]);
    expect(set.warnings).toEqual([]);
  });

  it('lists skills of every location sorted by name', async () => {
    const { set } = await loadFrom({
      [`${PROJECT}/.agents/skills/zeta/SKILL.md`]: skillFile('zeta', 'Z'),
      [`${HOME}/.agents/skills/beta/SKILL.md`]: skillFile('beta', 'B'),
      [`${PROJECT}/.momonga/skills/alpha/SKILL.md`]: skillFile('alpha', 'A'),
      [`${HOME}/.momonga/skills/gamma/SKILL.md`]: skillFile('gamma', 'G'),
    });
    expect(namesOf(set)).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
    expect(set.readDirectories).toHaveLength(4);
  });

  it('finds skills nested below the scanned directory but not inside a skill', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/group/inner/SKILL.md`]: skillFile('inner', 'Inner'),
      [`${HOME}/.agents/skills/outer/SKILL.md`]: skillFile('outer', 'Outer'),
      [`${HOME}/.agents/skills/outer/sub/SKILL.md`]: skillFile('sub', 'Hidden below a skill'),
    });
    expect(namesOf(set)).toEqual(['inner', 'outer']);
  });

  it('ignores .git and node_modules and files that are not named SKILL.md', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/.git/hook/SKILL.md`]: skillFile('hook', 'Hook'),
      [`${HOME}/.agents/skills/node_modules/dep/SKILL.md`]: skillFile('dep', 'Dep'),
      [`${HOME}/.agents/skills/readme/skill.md`]: skillFile('readme', 'Lowercase file name'),
      [`${HOME}/.agents/skills/README.md`]: 'not a skill',
    });
    expect(set.skills).toEqual([]);
  });

  it('stops descending after the maximum depth', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/a/b/c/deep/SKILL.md`]: skillFile('deep', 'Four levels down'),
      [`${HOME}/.agents/skills/a/b/c/d/tooDeep/SKILL.md`]: skillFile('toodeep', 'Five levels down'),
    });
    expect(namesOf(set)).toEqual(['deep']);
  });

  it('does not loop through a symlink cycle', async () => {
    const { set } = await loadFrom(
      { [`${HOME}/.agents/skills/real/SKILL.md`]: skillFile('real', 'Real'), [`${HOME}/.agents/skills/group/placeholder.txt`]: 'x' },
      true,
      { [`${HOME}/.agents/skills/group/back`]: `${HOME}/.agents/skills` },
    );
    expect(namesOf(set)).toEqual(['real']);
  });

  it('reads a skill reached through a symlinked directory and reports its real directory', async () => {
    const { set } = await loadFrom({ '/store/linked/SKILL.md': skillFile('linked', 'Linked') }, true, { [`${HOME}/.agents/skills/linked`]: '/store/linked' });
    expect(set.skills).toEqual([
      expect.objectContaining({ name: 'linked', directory: `${HOME}/.agents/skills/linked`, realDirectory: '/store/linked' }),
    ]);
    expect(set.readDirectories).toEqual(['/store/linked']);
  });

  it('scans nothing when no skills directory exists', async () => {
    const { set } = await loadFrom({});
    expect(set).toMatchObject({ skills: [], warnings: [], readDirectories: [], catalog: undefined });
  });
});

describe('name collisions', () => {
  it('lets a project skill beat a user skill and warns', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/review/SKILL.md`]: skillFile('review', 'User review'),
      [`${PROJECT}/.agents/skills/review/SKILL.md`]: skillFile('review', 'Project review'),
    });
    expect(set.skills).toEqual([expect.objectContaining({ name: 'review', scope: 'project', description: 'Project review' })]);
    expect(set.warnings).toEqual([
      `Skill "review" at ${HOME}/.agents/skills/review/SKILL.md was ignored because ${PROJECT}/.agents/skills/review/SKILL.md takes precedence`,
    ]);
  });

  it('lets the native directory beat the cross-client directory within one scope', async () => {
    const { set } = await loadFrom({
      [`${PROJECT}/.agents/skills/review/SKILL.md`]: skillFile('review', 'Cross client'),
      [`${PROJECT}/.momonga/skills/review/SKILL.md`]: skillFile('review', 'Native'),
    });
    expect(set.skills).toEqual([expect.objectContaining({ description: 'Native' })]);
    expect(set.warnings).toHaveLength(1);
    expect(set.warnings[0]).toContain(`${PROJECT}/.agents/skills/review/SKILL.md was ignored`);
  });

  it('applies the same precedence to the user scope', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/review/SKILL.md`]: skillFile('review', 'Cross client'),
      [`${HOME}/.momonga/skills/review/SKILL.md`]: skillFile('review', 'Native'),
    });
    expect(set.skills).toEqual([expect.objectContaining({ description: 'Native', scope: 'user' })]);
  });

  it('keeps one copy and one warning for a name declared twice below one directory', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/a/one/SKILL.md`]: skillFile('same', 'First'),
      [`${HOME}/.agents/skills/b/two/SKILL.md`]: skillFile('same', 'Second'),
    });
    expect(set.skills).toHaveLength(1);
    expect(set.skills[0]?.description).toBe('First');
    expect(set.warnings.filter((warning) => warning.includes('takes precedence'))).toHaveLength(1);
  });
});

describe('trust gate', () => {
  const files = {
    [`${PROJECT}/.agents/skills/project-only/SKILL.md`]: skillFile('project-only', 'Project'),
    [`${HOME}/.agents/skills/user-only/SKILL.md`]: skillFile('user-only', 'User'),
  };

  it('loads project skills in a trusted folder', async () => {
    expect(namesOf((await loadFrom(files, true)).set)).toEqual(['project-only', 'user-only']);
  });

  it('skips project skills in an untrusted folder, warns once per directory and still loads user skills', async () => {
    const { set, fileSystem } = await loadFrom(files, false);
    expect(namesOf(set)).toEqual(['user-only']);
    expect(set.warnings).toEqual([`Project skills in ${PROJECT}/.agents/skills were skipped because the folder is not trusted`]);
    expect(fileSystem.reads.filter((file) => file.startsWith(PROJECT))).toEqual([]);
  });

  it('says nothing about an untrusted folder without project skill directories', async () => {
    const { set } = await loadFrom({ [`${HOME}/.agents/skills/user-only/SKILL.md`]: skillFile('user-only', 'User') }, false);
    expect(set.warnings).toEqual([]);
  });

  it('does not offer the directories of skipped project skills for reading', async () => {
    const { set } = await loadFrom(files, false);
    expect(set.readDirectories).toEqual([`${HOME}/.agents/skills/user-only`]);
  });
});

describe('lenient validation', () => {
  const location = `${HOME}/.agents/skills/pdf/SKILL.md`;

  it('loads a description that contains a colon', async () => {
    const { set } = await loadFrom({ [location]: skillFile('pdf', 'Use this skill when: the user asks about PDFs') });
    expect(set.skills[0]?.description).toBe('Use this skill when: the user asks about PDFs');
    expect(set.warnings).toEqual([]);
  });

  it('skips a skill without a description', async () => {
    const { set } = await loadFrom({ [location]: skillFile('pdf', undefined) });
    expect(set.skills).toEqual([]);
    expect(set.warnings).toEqual([`Skill at ${location} was skipped: the description is missing or empty`]);
  });

  it.each([['empty', "''"], ['blank', '"   "'], ['a number', '42'], ['a list', '[a, b]']])('skips a skill whose description is %s', async (_label, value) => {
    const { set } = await loadFrom({ [location]: `---\nname: pdf\ndescription: ${value}\n---\nBody` });
    expect(set.skills).toEqual([]);
    expect(set.warnings).toHaveLength(1);
  });

  it('skips a skill whose YAML is broken', async () => {
    const { set } = await loadFrom({ [location]: '---\nname: pdf\ndescription: [oops\n---\nBody' });
    expect(set.skills).toEqual([]);
    expect(set.warnings[0]).toContain(`Skill at ${location} was skipped: the frontmatter is not valid YAML`);
  });

  it('skips a file without frontmatter', async () => {
    const { set } = await loadFrom({ [location]: '# no frontmatter' });
    expect(set.skills).toEqual([]);
    expect(set.warnings).toHaveLength(1);
  });

  it('loads a skill whose name differs from its directory and warns', async () => {
    const { set } = await loadFrom({ [location]: skillFile('other-name', 'Pdf things') });
    expect(namesOf(set)).toEqual(['other-name']);
    expect(set.warnings).toEqual([`Skill "other-name" at ${location} does not match its directory name "pdf"`]);
  });

  it('uses the directory name for a skill without a name and warns', async () => {
    const { set } = await loadFrom({ [location]: skillFile(undefined, 'Pdf things') });
    expect(namesOf(set)).toEqual(['pdf']);
    expect(set.warnings).toEqual([`Skill at ${location} has no name; the directory name "pdf" is used`]);
  });

  it.each([['uppercase', 'PDF-Tools'], ['leading hyphen', '-pdf'], ['trailing hyphen', 'pdf-'], ['double hyphen', 'pdf--tools'], ['too long', 'a'.repeat(65)]])(
    'loads a name with %s and warns',
    async (_label, name) => {
      const { set } = await loadFrom({ [`${HOME}/.agents/skills/${name}/SKILL.md`]: skillFile(name, 'Odd name') });
      expect(namesOf(set)).toEqual([name]);
      expect(set.warnings).toHaveLength(1);
      expect(set.warnings[0]).toContain('lowercase letters, digits and single hyphens');
    },
  );

  it('loads a description over the limit and warns', async () => {
    const { set } = await loadFrom({ [location]: skillFile('pdf', 'x'.repeat(1025)) });
    expect(set.skills).toHaveLength(1);
    expect(set.warnings).toEqual([`Skill "pdf" at ${location} has a description longer than 1024 characters`]);
  });

  it('accepts unicode lowercase names without a warning', async () => {
    const { set } = await loadFrom({ [`${HOME}/.agents/skills/résumé/SKILL.md`]: skillFile('résumé', 'Accented') });
    expect(set.warnings).toEqual([]);
  });

  it('keeps loading the other skills after a broken one', async () => {
    const { set } = await loadFrom({
      [`${HOME}/.agents/skills/broken/SKILL.md`]: '---\n: : :\n  - [\n---\n',
      [`${HOME}/.agents/skills/fine/SKILL.md`]: skillFile('fine', 'Fine'),
    });
    expect(namesOf(set)).toEqual(['fine']);
    expect(set.warnings).toHaveLength(1);
  });
});
