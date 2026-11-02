import { BSD_SPECS } from './bsd-specs.ts';
import { NEUTRAL_SPECS, specsOf } from './command-specs.ts';
import type { CommandSpecs } from './command-specs.ts';
import { GNU_SPECS } from './gnu-specs.ts';

export type UserlandFamily = 'bsd' | 'gnu';

export const userlandOf = (platform: NodeJS.Platform): UserlandFamily => (platform === 'darwin' || platform.endsWith('bsd') ? 'bsd' : 'gnu');

export const SYSTEM_PROGRAM_DIRECTORIES: Readonly<Record<'darwin' | 'linux', readonly string[]>> = {
  darwin: ['/bin', '/usr/bin'],
  linux: ['/bin', '/usr/bin'],
};

export const systemProgramDirectories = (platform: NodeJS.Platform): readonly string[] =>
  platform === 'darwin' ? SYSTEM_PROGRAM_DIRECTORIES.darwin : platform === 'linux' ? SYSTEM_PROGRAM_DIRECTORIES.linux : [];

const BSD = specsOf([...BSD_SPECS, ...NEUTRAL_SPECS]);
const GNU = specsOf([...GNU_SPECS, ...NEUTRAL_SPECS]);

export const commandSpecsFor = (platform: NodeJS.Platform): CommandSpecs => (userlandOf(platform) === 'bsd' ? BSD : GNU);
