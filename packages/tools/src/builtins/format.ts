export const MAX_LINE_CHARS = 2000;
export const DEFAULT_LINE_LIMIT = 2000;
const TRUNCATED_LINE_SUFFIX = '… [line truncated]';
const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

export const cutLine = (line: string): string => {
  if (line.length <= MAX_LINE_CHARS) return line;
  const head = line.slice(0, MAX_LINE_CHARS);
  return `${HIGH_SURROGATE.test(head) ? head.slice(0, -1) : head}${TRUNCATED_LINE_SUFFIX}`;
};

export const numberedLines = (lines: readonly string[], firstLineNumber: number): string =>
  lines.map((line, index) => `${String(firstLineNumber + index).padStart(6)}\t${cutLine(line)}`).join('\n');

export const pluralize = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`;

export const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

export const pastEndMessage = (offset: number, subject: string, totalLines: number): string =>
  `offset ${offset} is past the end of the ${subject} (${pluralize(totalLines, 'line', 'lines')})`;

const continuationNote = (first: number, last: number): string => `[Showed lines ${first}–${last}. Continue with offset=${last + 1}.]`;

const fitSingleLine = (line: string, lineNumber: number, available: number): string => {
  const prefix = `${String(lineNumber).padStart(6)}\t`;
  const numbered = `${prefix}${cutLine(line)}`;
  if (numbered.length <= available) return numbered;
  const room = Math.max(0, available - prefix.length - TRUNCATED_LINE_SUFFIX.length);
  const head = line.slice(0, room);
  return `${prefix}${HIGH_SURROGATE.test(head) ? head.slice(0, -1) : head}${TRUNCATED_LINE_SUFFIX}`;
};

export const pageNumberedLines = (lines: readonly string[], firstLine: number, totalLines: number, budget: number): string => {
  const shown: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const lineNumber = firstLine + index;
    const reserve = continuationNote(firstLine, lineNumber).length + 1;
    if (index === 0) {
      shown.push(fitSingleLine(line, lineNumber, budget - reserve));
      used = (shown[0] as string).length;
      continue;
    }
    const numbered = numberedLines([line], lineNumber);
    if (used + 1 + numbered.length + reserve > budget) break;
    shown.push(numbered);
    used += 1 + numbered.length;
  }
  const lastShown = firstLine + shown.length - 1;
  return [...shown, ...(lastShown < totalLines ? [continuationNote(firstLine, lastShown)] : [])].join('\n');
};
