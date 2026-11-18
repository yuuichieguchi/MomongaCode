import path from 'node:path';
import { escapeTerminalLine } from '@momonga/protocol';

const ESC = '\u001b';

export const BEL = '\u0007';

export const TITLE_MAX_CHARACTERS = 120;

export const TITLE_STATES = ['ready', 'working', 'waiting for you', 'done', 'error'] as const;

export type TitleState = (typeof TITLE_STATES)[number];

export type RunEnd = 'done' | 'error';

export type TitleFacts = { working: boolean; prompting: boolean; lastRun: RunEnd | undefined };

const PRODUCT = 'momonga';
const SEPARATOR = ' · ';

const withoutControls = (text: string): string => [...text].filter((character) => escapeTerminalLine(character) === character).join('');

export const titleStateOf = ({ working, prompting, lastRun }: TitleFacts): TitleState => {
  if (prompting) return 'waiting for you';
  if (working) return 'working';
  return lastRun ?? 'ready';
};

export const titleOf = (cwd: string, state: TitleState): string => {
  const head = `${state}${SEPARATOR}`;
  const tail = `${SEPARATOR}${PRODUCT}`;
  const folder = [...withoutControls(path.basename(cwd))].slice(0, TITLE_MAX_CHARACTERS - [...head].length - [...tail].length).join('');
  return `${head}${folder}${tail}`;
};

export const titleSequence = (title: string): string => `${ESC}]2;${title}${ESC}\\`;
