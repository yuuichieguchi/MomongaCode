import path from 'node:path';
import { SKILL_CONTENT_CLOSE_TAG, skillContentOpenTag } from '@momonga/protocol';
import { IGNORED_DIRECTORY_NAMES, SKILL_FILE_NAME } from './constants.ts';
import type { SkillLimits } from './constants.ts';
import { attemptRead } from './file-system.ts';
import type { SkillFileSystem } from './file-system.ts';
import { parseSkillFile } from './frontmatter.ts';
import { escapeText } from './xml.ts';
import { SkillActivationError } from './types.ts';
import type { Skill, SkillContent } from './types.ts';

type Resources = { files: string[]; complete: boolean };

const resourcesOf = async (skill: Skill, fileSystem: SkillFileSystem, limits: SkillLimits): Promise<Resources> => {
  const files: string[] = [];
  const queue: { directory: string; depth: number }[] = [{ directory: skill.directory, depth: 0 }];
  let visited = 0;
  let complete = true;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (visited >= limits.maxDirectories) return { files, complete: false };
    visited += 1;
    const listing = await attemptRead(() => fileSystem.listDirectory(next.directory));
    if (listing.kind === 'unreadable') {
      complete = false;
      continue;
    }
    const entries = listing.value;
    if (entries === undefined) continue;
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const relative = path.relative(skill.directory, path.join(next.directory, entry.name));
      if (entry.kind === 'unreadable') complete = false;
      else if (entry.kind === 'file' && relative !== SKILL_FILE_NAME) {
        if (files.length >= limits.maxResources) return { files, complete: false };
        files.push(relative);
      } else if (entry.kind === 'directory' && !IGNORED_DIRECTORY_NAMES.has(entry.name) && next.depth < limits.maxDepth) {
        queue.push({ directory: path.join(next.directory, entry.name), depth: next.depth + 1 });
      }
    }
  }
  return { files, complete };
};

const resourcesBlock = ({ files, complete }: Resources): string[] =>
  files.length === 0 && complete
    ? []
    : [
        '',
        complete ? '<skill_resources>' : '<skill_resources complete="false">',
        ...files.sort().map((file) => `  <file>${escapeText(file)}</file>`),
        '</skill_resources>',
      ];

export const activateSkill = async (skill: Skill, fileSystem: SkillFileSystem, limits: SkillLimits): Promise<SkillContent> => {
  const text = await fileSystem.readText(skill.location);
  if (text === undefined) throw new SkillActivationError(`the SKILL.md of skill ${JSON.stringify(skill.name)} no longer exists at ${skill.location}`);
  const parsed = parseSkillFile(text);
  if (parsed.kind === 'invalid') throw new SkillActivationError(`the SKILL.md of skill ${JSON.stringify(skill.name)} at ${skill.location} can no longer be read: ${parsed.reason}`);
  const resources = await resourcesOf(skill, fileSystem, limits);
  const content = [
    skillContentOpenTag(skill.name),
    parsed.body,
    '',
    `Skill directory: ${skill.directory}`,
    'Relative paths in this skill are relative to the skill directory.',
    ...resourcesBlock(resources),
    SKILL_CONTENT_CLOSE_TAG,
  ].join('\n');
  return { name: skill.name, content };
};
