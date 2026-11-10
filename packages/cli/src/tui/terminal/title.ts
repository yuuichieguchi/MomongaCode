import path from 'node:path';
import { escapeTerminalLine } from '@momonga/protocol';

const ESC = '\u001b';

export const TITLE_MAX_CHARACTERS = 120;

const PRODUCT = 'momonga';
const SEPARATOR = ' · ';

const withoutControls = (text: string): string => [...text].filter((character) => escapeTerminalLine(character) === character).join('');

export const titleOf = (cwd: string): string => [...withoutControls(`${PRODUCT}${SEPARATOR}${path.basename(cwd)}`)].slice(0, TITLE_MAX_CHARACTERS).join('');

export const titleSequence = (title: string): string => `${ESC}]2;${title}${ESC}\\`;
