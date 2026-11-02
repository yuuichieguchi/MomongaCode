import path from 'node:path';

export type PathFlavour = 'posix' | 'win32';

export const HOST_FLAVOUR: PathFlavour = path.sep === '\\' ? 'win32' : 'posix';

export const flavourOf = (platform: NodeJS.Platform): PathFlavour => (platform === 'win32' ? 'win32' : 'posix');

const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/s;
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/](.*))?$/s;
const PATTERN_DRIVE = /^\/([a-z])(?:\/(.*))?$/s;
const PATTERN_UNC = /^\/unc\/([^/]+)\/([^/]+)(?:\/(.*))?$/s;

const forward = (text: string): string => text.replace(/\\/g, '/');

const joined = (head: string, rest: string | undefined): string => (rest === undefined || rest === '' ? head : `${head}/${forward(rest)}`);

export const patternPathOf = (flavour: PathFlavour, native: string): string => {
  if (flavour === 'posix') return native;
  const drive = DRIVE.exec(native);
  if (drive !== null) return joined(`/${(drive[1] as string).toLowerCase()}`, drive[2]);
  const unc = UNC.exec(native);
  if (unc !== null) return joined(`/unc/${unc[1] as string}/${unc[2] as string}`, unc[3]);
  return forward(native);
};

export const nativePathOf = (flavour: PathFlavour, pattern: string): string => {
  if (flavour === 'posix') return pattern;
  const unc = PATTERN_UNC.exec(pattern);
  if (unc !== null) return `\\\\${unc[1] as string}\\${unc[2] as string}${unc[3] === undefined || unc[3] === '' ? '' : `\\${unc[3].replace(/\//g, '\\')}`}`;
  const drive = PATTERN_DRIVE.exec(pattern);
  if (drive !== null) return `${(drive[1] as string).toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`;
  return pattern.replace(/\//g, '\\');
};

export const specifierOf = (flavour: PathFlavour, specifier: string): string => {
  if (flavour === 'posix') return specifier;
  if (DRIVE.test(specifier) || (specifier.startsWith('\\\\') && UNC.test(specifier))) return `/${patternPathOf(flavour, specifier)}`;
  return specifier;
};
