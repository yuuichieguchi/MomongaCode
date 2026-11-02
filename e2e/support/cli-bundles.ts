import path from 'node:path';
import { REPO_ROOT } from './launcher.ts';

export const CLI_BUNDLE = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'main.js');
export const CLI_FAKES_ENTRY = path.join(REPO_ROOT, 'e2e', 'support', 'cli-fakes-main.ts');
export const CLI_FAKES_BUNDLE = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli-fakes-main.js');
