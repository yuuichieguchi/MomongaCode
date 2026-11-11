export { SYSTEM_PROGRAM_DIRECTORIES, systemProgramDirectories } from '@momonga/foundation';
import { BSD_SPECS } from './bsd-specs.ts';
import { NEUTRAL_SPECS, specsOf } from './command-specs.ts';
import type { CommandSpecs } from './command-specs.ts';
import { GNU_SPECS } from './gnu-specs.ts';

export type UserlandFamily = 'bsd' | 'gnu';

export const userlandOf = (platform: NodeJS.Platform): UserlandFamily => (platform === 'darwin' || platform.endsWith('bsd') ? 'bsd' : 'gnu');

const BSD = specsOf([...BSD_SPECS, ...NEUTRAL_SPECS]);
const GNU = specsOf([...GNU_SPECS, ...NEUTRAL_SPECS]);

export const commandSpecsFor = (platform: NodeJS.Platform): CommandSpecs => (userlandOf(platform) === 'bsd' ? BSD : GNU);
