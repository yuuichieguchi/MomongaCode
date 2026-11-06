import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const AUTO_MODE_DATASET_TEXT = fs.readFileSync(fileURLToPath(new URL('../../eval/datasets/auto-mode.json', import.meta.url)), 'utf8');
