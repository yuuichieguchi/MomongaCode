export type Version = { major: number; minor: number; patch: number; text: string };

const VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

const ORDERED_VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-[0-9A-Za-z.-]+)?$/;

const versionOf = (match: RegExpExecArray, text: string): Version => ({ major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text });

export const tryParseVersion = (text: string): Version | undefined => {
  const match = VERSION_PATTERN.exec(text);
  return match === null ? undefined : versionOf(match, text);
};

export const compareVersions = (left: Version, right: Version): -1 | 0 | 1 => {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return 0;
};

export type VersionOrder = 'same' | 'newer' | 'older' | 'unordered';

const precedenceOf = (text: string): Version | undefined => {
  const match = ORDERED_VERSION_PATTERN.exec(text);
  return match === null ? undefined : versionOf(match, text);
};

export const orderVersions = (subject: string, reference: string): VersionOrder => {
  if (subject === reference) return 'same';
  const left = precedenceOf(subject);
  const right = precedenceOf(reference);
  if (left === undefined || right === undefined) return 'unordered';
  const compared = compareVersions(left, right);
  if (compared === 0) return 'unordered';
  return compared === 1 ? 'newer' : 'older';
};

export const isAtLeastVersion = (subject: string, reference: string): boolean => {
  const order = orderVersions(subject, reference);
  return order === 'same' || order === 'newer';
};
