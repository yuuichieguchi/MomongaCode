const LINE_COMMENT = '\\*';
const BLOCK_OPEN = '(*';
const BLOCK_CLOSE = '*)';
const QUOTE = '"';
const ESCAPE = '\\';

const stringEnd = (text: string, start: number): number => {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === ESCAPE) index += 2;
    else if (text[index] === QUOTE) return index + 1;
    else index += 1;
  }
  return text.length;
};

const blockEnd = (text: string, start: number): number => {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith(BLOCK_OPEN, index)) {
      depth += 1;
      index += BLOCK_OPEN.length;
    } else if (text.startsWith(BLOCK_CLOSE, index)) {
      depth -= 1;
      index += BLOCK_CLOSE.length;
      if (depth === 0) return index;
    } else index += 1;
  }
  return text.length;
};

export const withoutComments = (text: string): string => {
  let kept = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === QUOTE) {
      const end = stringEnd(text, index);
      kept += text.slice(index, end);
      index = end;
    } else if (text.startsWith(LINE_COMMENT, index)) {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
    } else if (text.startsWith(BLOCK_OPEN, index)) {
      index = blockEnd(text, index);
      kept += ' ';
    } else {
      kept += text[index];
      index += 1;
    }
  }
  return kept
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
};
