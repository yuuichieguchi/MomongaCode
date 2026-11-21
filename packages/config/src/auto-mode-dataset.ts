import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const readDataset = (name: string): string => fs.readFileSync(fileURLToPath(new URL(`../../eval/datasets/${name}`, import.meta.url)), 'utf8');

export const AUTO_MODE_DATASET_TEXT = readDataset('auto-mode.json');
export const CONTEXT_DATASET_TEXT = readDataset('context.json');
