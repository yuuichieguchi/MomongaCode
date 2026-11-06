const COLLAPSED = /^(.*) \[×(\d+)\]$/;

type Entry = { text: string; count: number };

const collapsed = (lines: readonly string[]): Entry[] => {
  const entries: Entry[] = [];
  for (const line of lines) {
    const last = entries.at(-1);
    if (last !== undefined && last.text === line && line !== '') last.count += 1;
    else entries.push({ text: line, count: 1 });
  }
  return entries;
};

const renderedText = (entry: Entry): string => (entry.count > 1 ? `${entry.text} [×${entry.count}]` : entry.text);

export const formatLog = (raw: string): string => collapsed(raw.split('\n')).map(renderedText).join('\n');

export const expandedLog = (formatted: string): string =>
  formatted
    .split('\n')
    .flatMap((line) => {
      const match = COLLAPSED.exec(line);
      return match === null ? [line] : Array.from({ length: Number(match[2]) }, () => match[1] as string);
    })
    .join('\n');
