import path from 'node:path';
import { momongaLayout } from '@momonga/foundation';
import type { SkillScope } from '@momonga/protocol';
import {
  DESCRIPTION_MAX_LENGTH,
  IGNORED_DIRECTORY_NAMES,
  NAME_MAX_LENGTH,
  SKILL_DIRECTORY_SEGMENTS,
  SKILL_FILE_NAME,
} from './constants.ts';
import type { SkillLimits } from './constants.ts';
import { attemptRead, describeUnreadable } from './file-system.ts';
import type { SkillFileSystem } from './file-system.ts';
import { parseSkillFile } from './frontmatter.ts';
import type { Skill } from './types.ts';

export type ScanRequest = { home: string; projectRoot: string; trusted: boolean };

export type ScanResult = { skills: Skill[]; warnings: string[] };

type Location = { scope: SkillScope; directory: string };

const VALID_NAME = /^(?!-)(?!.*--)[\p{Ll}\p{Nd}-]+(?<!-)$/u;

const locationsOf = ({ home, projectRoot }: ScanRequest): Location[] => [
  { scope: 'project', directory: path.join(projectRoot, SKILL_DIRECTORY_SEGMENTS.native) },
  { scope: 'project', directory: path.join(projectRoot, SKILL_DIRECTORY_SEGMENTS.crossClient) },
  { scope: 'user', directory: momongaLayout(home).skills },
  { scope: 'user', directory: path.join(home, SKILL_DIRECTORY_SEGMENTS.crossClient) },
];

const byName = (left: { name: string }, right: { name: string }): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

const skillDirectoriesUnder = async (
  root: string,
  fileSystem: SkillFileSystem,
  limits: SkillLimits,
  warnings: string[],
): Promise<string[]> => {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }];
  let visited = 0;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (visited >= limits.maxDirectories) {
      warnings.push(`Skill scan of ${root} stopped after ${limits.maxDirectories} directories; skills beyond that point were not loaded`);
      break;
    }
    const resolved = await attemptRead(() => fileSystem.realpath(next.directory));
    if (resolved.kind === 'unreadable') {
      warnings.push(`Skill scan skipped ${describeUnreadable(resolved.error)}`);
      continue;
    }
    const real = resolved.value;
    if (real === undefined || seen.has(real)) continue;
    seen.add(real);
    const listing = await attemptRead(() => fileSystem.listDirectory(next.directory));
    if (listing.kind === 'unreadable') {
      warnings.push(`Skill scan skipped ${describeUnreadable(listing.error)}`);
      continue;
    }
    const entries = listing.value;
    if (entries === undefined) continue;
    visited += 1;
    if (entries.some((entry) => entry.name === SKILL_FILE_NAME && entry.kind === 'file')) {
      found.push(next.directory);
      continue;
    }
    if (next.depth >= limits.maxDepth) continue;
    const children = entries
      .filter((entry) => entry.kind === 'directory' && !IGNORED_DIRECTORY_NAMES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const child of children) queue.push({ directory: path.join(next.directory, child), depth: next.depth + 1 });
  }
  return found;
};

const skillOf = async (
  directory: string,
  scope: SkillScope,
  fileSystem: SkillFileSystem,
  warnings: string[],
): Promise<Skill | undefined> => {
  const location = path.join(directory, SKILL_FILE_NAME);
  const reading = await attemptRead(() => fileSystem.readText(location));
  if (reading.kind === 'unreadable') {
    warnings.push(`Skill at ${location} was skipped: ${describeUnreadable(reading.error)}`);
    return undefined;
  }
  const text = reading.value;
  if (text === undefined) {
    warnings.push(`Skill at ${location} was skipped: the file disappeared while scanning`);
    return undefined;
  }
  const parsed = parseSkillFile(text);
  if (parsed.kind === 'invalid') {
    warnings.push(`Skill at ${location} was skipped: ${parsed.reason}`);
    return undefined;
  }
  const { description, name: declaredName } = parsed.fields;
  if (typeof description !== 'string' || description.trim() === '') {
    warnings.push(`Skill at ${location} was skipped: the description is missing or empty`);
    return undefined;
  }
  const directoryName = path.basename(directory);
  let name = directoryName;
  if (typeof declaredName === 'string' && declaredName.trim() !== '') {
    name = declaredName.trim();
    if (name !== directoryName) warnings.push(`Skill ${JSON.stringify(name)} at ${location} does not match its directory name ${JSON.stringify(directoryName)}`);
    if (name.length > NAME_MAX_LENGTH || !VALID_NAME.test(name)) {
      warnings.push(`Skill name ${JSON.stringify(name)} at ${location} should be at most ${NAME_MAX_LENGTH} lowercase letters, digits and single hyphens that neither start nor end the name`);
    }
  } else {
    warnings.push(`Skill at ${location} has no name; the directory name ${JSON.stringify(directoryName)} is used`);
  }
  const trimmedDescription = description.trim();
  if (trimmedDescription.length > DESCRIPTION_MAX_LENGTH) {
    warnings.push(`Skill ${JSON.stringify(name)} at ${location} has a description longer than ${DESCRIPTION_MAX_LENGTH} characters`);
  }
  const resolution = await attemptRead(() => fileSystem.realpath(directory));
  if (resolution.kind === 'unreadable') {
    warnings.push(`Skill at ${location} was skipped: ${describeUnreadable(resolution.error)}`);
    return undefined;
  }
  const realDirectory = resolution.value;
  if (realDirectory === undefined) {
    warnings.push(`Skill at ${location} was skipped: the directory disappeared while scanning`);
    return undefined;
  }
  return { name, description: trimmedDescription, scope, location, directory, realDirectory };
};

export const scanSkills = async (request: ScanRequest, fileSystem: SkillFileSystem, limits: SkillLimits): Promise<ScanResult> => {
  const warnings: string[] = [];
  const chosen = new Map<string, Skill>();
  for (const { scope, directory: root } of locationsOf(request)) {
    if (scope === 'project' && !request.trusted) {
      const listing = await attemptRead(() => fileSystem.listDirectory(root));
      if (listing.kind === 'unreadable' || listing.value !== undefined) {
        warnings.push(`Project skills in ${root} were skipped because the folder is not trusted`);
      }
      continue;
    }
    for (const directory of await skillDirectoriesUnder(root, fileSystem, limits, warnings)) {
      const skill = await skillOf(directory, scope, fileSystem, warnings);
      if (skill === undefined) continue;
      const existing = chosen.get(skill.name);
      if (existing === undefined) {
        chosen.set(skill.name, skill);
        continue;
      }
      warnings.push(`Skill ${JSON.stringify(skill.name)} at ${skill.location} was ignored because ${existing.location} takes precedence`);
    }
  }
  return { skills: [...chosen.values()].sort(byName), warnings };
};
