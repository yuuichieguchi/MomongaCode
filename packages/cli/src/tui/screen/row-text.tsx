import { Text } from 'ink';
import { styleOf } from './tokens.ts';
import type { StyleToken, TextStyle } from './tokens.ts';
import type { Row } from './wrap.ts';

const OSC = '\u001b]';
const BEL = '\u0007';

export const hyperlink = (url: string, text: string): string => `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`;

export type Piece = { text: string; style: TextStyle; url: string | undefined };

export const piecesOf = (row: Row, selected: readonly [number, number] | undefined): Piece[] => {
  const links = row.links ?? [];
  const edges = new Set<number>([0, row.text.length]);
  for (const [start, end] of [...row.spans, ...links, ...(selected === undefined ? [] : [selected])]) {
    edges.add(Math.min(start, row.text.length));
    edges.add(Math.min(end, row.text.length));
  }
  const sorted = [...edges].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((from, index) => {
    const to = sorted[index + 1] ?? row.text.length;
    const covers = ([start, end]: readonly [number, number, ...unknown[]]): boolean => start <= from && end >= to;
    const link = links.find(covers);
    const tokens: StyleToken[] = [...row.spans.filter(covers).map((span) => span[2]), ...(link === undefined ? [] : ['link' as const]), ...(selected !== undefined && covers(selected) ? ['selection' as const] : [])];
    return { text: row.text.slice(from, to), style: styleOf(tokens), url: link?.[2] };
  });
};

export function RowText({ row, selected }: { row: Row; selected?: readonly [number, number] | undefined }) {
  if (row.text === '') return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {piecesOf(row, selected).map((piece, index) => (
        <Text key={index} {...piece.style}>
          {piece.url === undefined ? piece.text : hyperlink(piece.url, piece.text)}
        </Text>
      ))}
    </Text>
  );
}
