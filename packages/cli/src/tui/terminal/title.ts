import path from 'node:path';
import { escapeTerminalLine } from '@momonga/protocol';
import { SPINNER_FRAMES, STATIC_MARK } from './marks.ts';

const ESC = '\u001b';

export const BEL = '\u0007';

export const TITLE_MAX_CHARACTERS = 120;

export const TITLE_BLINK_MS = 1000;

export const TITLE_STATES = ['ready', 'working', 'waiting for you', 'done', 'error'] as const;

export type TitleState = (typeof TITLE_STATES)[number];

export type RunEnd = 'done' | 'error';

export type TitleFacts = { working: boolean; prompting: boolean; lastRun: RunEnd | undefined };

const PRODUCT = 'momonga';
const SEPARATOR = ' - ';

const withoutControls = (text: string): string => [...text].filter((character) => escapeTerminalLine(character) === character).join('');

export const titleStateOf = ({ working, prompting, lastRun }: TitleFacts): TitleState => {
  if (prompting) return 'waiting for you';
  if (working) return 'working';
  return lastRun ?? 'ready';
};

const headOf = (state: TitleState, step: number, reducedMotion: boolean): string => {
  if (state === 'waiting for you') return `[ ${!reducedMotion && step % 2 === 1 ? '.' : '!'} ] Action Required${SEPARATOR}`;
  if (state === 'working') return `${reducedMotion ? STATIC_MARK : SPINNER_FRAMES[step % SPINNER_FRAMES.length]} `;
  return '';
};

export const titleOf = ({ cwd, state, step, reducedMotion }: { cwd: string; state: TitleState; step: number; reducedMotion: boolean }): string => {
  const head = headOf(state, step, reducedMotion);
  const tail = `${SEPARATOR}${PRODUCT}`;
  const folder = [...withoutControls(path.basename(cwd))].slice(0, TITLE_MAX_CHARACTERS - [...head].length - [...tail].length).join('');
  return `${head}${folder}${tail}`;
};

export const titleSequence = (title: string): string => `${ESC}]2;${title}${ESC}\\`;

export const NOTIFICATION_MAX_BYTES = 255;

const ELLIPSIS = '…';

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

const cappedToBytes = (text: string, limit: number): string => {
  if (bytesOf(text) <= limit) return text;
  const room = limit - bytesOf(ELLIPSIS);
  let kept = '';
  let used = 0;
  for (const character of text) {
    const size = bytesOf(character);
    if (used + size > room) break;
    kept += character;
    used += size;
  }
  return `${kept}${ELLIPSIS}`;
};

const tidied = (text: string): string => withoutControls(text.replace(/\s+/gu, ' ')).trim();

export const notificationText = (detail: string, suffix: string | undefined): string => {
  const head = tidied(detail);
  if (suffix === undefined) return cappedToBytes(head, NOTIFICATION_MAX_BYTES);
  const tail = `${SEPARATOR}${tidied(suffix)}`;
  const room = NOTIFICATION_MAX_BYTES - bytesOf(tail);
  if (room < bytesOf(ELLIPSIS)) return cappedToBytes(`${head}${tail}`, NOTIFICATION_MAX_BYTES);
  return `${cappedToBytes(head, room)}${tail}`;
};

export const notificationSequence = (text: string): string => `${ESC}]9;${cappedToBytes(withoutControls(text), NOTIFICATION_MAX_BYTES)}${BEL}`;

export const tmuxPassthrough = (sequence: string): string => `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\`;
