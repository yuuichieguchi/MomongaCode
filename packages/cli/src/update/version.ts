import { compareVersions, tryParseVersion } from '@momonga/foundation';
import type { Version } from '@momonga/foundation';
import { UpdateError } from './errors.ts';

export { compareVersions, tryParseVersion };
export type { Version };

export const parseVersion = (text: string, origin: string): Version => {
  const version = tryParseVersion(text);
  if (version === undefined) throw new UpdateError('version_malformed', `${origin} is not a MAJOR.MINOR.PATCH version`, { detail: JSON.stringify(text) });
  return version;
};

export const parseReleaseTag = (tag: string): Version => {
  if (!tag.startsWith('v')) throw new UpdateError('version_malformed', 'the latest release tag does not start with "v"', { detail: JSON.stringify(tag) });
  return parseVersion(tag.slice(1), 'the latest release tag');
};
