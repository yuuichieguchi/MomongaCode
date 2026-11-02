import { UpdateError } from './errors.ts';

export type Version = { major: number; minor: number; patch: number; text: string };

const VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

export const parseVersion = (text: string, origin: string): Version => {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) throw new UpdateError('version_malformed', `${origin} is not a MAJOR.MINOR.PATCH version`, { detail: JSON.stringify(text) });
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text };
};

export const parseReleaseTag = (tag: string): Version => {
  if (!tag.startsWith('v')) throw new UpdateError('version_malformed', 'the latest release tag does not start with "v"', { detail: JSON.stringify(tag) });
  return parseVersion(tag.slice(1), 'the latest release tag');
};

export const compareVersions = (left: Version, right: Version): -1 | 0 | 1 => {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return 0;
};
