const RECORD = /^(.+?):(\d+):(.*)$/;
const AMBIGUOUS_TEXT = /^[^\s:]*:\d+:/;
const ENTRY_SHAPED = /^\d+(?:,\d+)*: /;

type GrepRecord = { path: string; line: string; text: string };

const parseRecord = (line: string): GrepRecord | undefined => {
  const match = RECORD.exec(line);
  if (match === null) return undefined;
  const [, path, lineNumber, text] = match as unknown as [string, string, string, string];
  if (AMBIGUOUS_TEXT.test(text) || ENTRY_SHAPED.test(path)) return undefined;
  return { path, line: lineNumber, text };
};

export const formatGrep = (raw: string): string | undefined => {
  const records: GrepRecord[] = [];
  for (const line of raw.split('\n')) {
    const record = parseRecord(line);
    if (record === undefined) return undefined;
    records.push(record);
  }
  const files = new Map<string, Map<string, string[]>>();
  for (const { path, line, text } of records) {
    const texts = files.get(path) ?? new Map<string, string[]>();
    files.set(path, texts);
    const numbers = texts.get(text) ?? [];
    numbers.push(line);
    texts.set(text, numbers);
  }
  return [...files].flatMap(([path, texts]) => [path, ...[...texts].map(([text, numbers]) => `${numbers.join(',')}: ${text}`)]).join('\n');
};
