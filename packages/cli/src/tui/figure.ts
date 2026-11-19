import type { StyleToken } from './screen/tokens.ts';

export type ArtPart = { text: string; token?: StyleToken };

const ART: readonly (readonly ArtPart[])[] = [
  [{ text: '     ' }, { text: '∩   ∩', token: 'banner.fur' }],
  [{ text: '╭────', token: 'banner.membrane' }, { text: '(', token: 'banner.fur' }, { text: '•ᴥ•', token: 'banner.face' }, { text: ')', token: 'banner.fur' }, { text: '────╮', token: 'banner.membrane' }],
  [{ text: '╰╮░░░░░░░░░░░╭╯', token: 'banner.membrane' }],
  [{ text: ' ' }, { text: '╰─╮░░░░░░░╭─╯', token: 'banner.membrane' }],
  [{ text: '   ' }, { text: '╰─╮░░░╭─╯', token: 'banner.membrane' }],
  [{ text: '     ' }, { text: '╰─', token: 'banner.membrane' }, { text: '┬', token: 'banner.fur' }, { text: '─╯', token: 'banner.membrane' }],
];

const RESTING_TAIL: readonly ArtPart[] = [{ text: '       ' }, { text: '╰─╮', token: 'banner.fur' }];

const SWUNG_TAIL: readonly ArtPart[] = [{ text: '     ' }, { text: '╭─╯', token: 'banner.fur' }];

export const TAIL_WAG_FRAMES = 6;

export const TAIL_WAG_MS = 300;

export type ArtRow = { rest: readonly ArtPart[]; swing?: readonly ArtPart[] };

export const FIGURE: readonly ArtRow[] = [...ART.map((rest): ArtRow => ({ rest })), { rest: RESTING_TAIL, swing: SWUNG_TAIL }];

const lengthOfRow = (row: readonly { text: string }[]): number => row.reduce((total, part) => total + [...part.text].length, 0);

export const ART_WIDTH = Math.max(...FIGURE.flatMap((row) => [row.rest, ...(row.swing === undefined ? [] : [row.swing])]).map(lengthOfRow));
