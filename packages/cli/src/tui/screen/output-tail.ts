export const OUTPUT_TAIL_MAX_BYTES = 8 * 1024;
export const OUTPUT_TAIL_LINES = 5;

export const ELLIPSIS = '…';
const utf8 = new TextEncoder();

const bytesOfCode = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);

const unitsAt = (text: string, at: number): number => ((text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1);

export const byteLengthOf = (text: string): number => utf8.encode(text).length;

export const startWithinBytes = (text: string, end: number, maxBytes: number): number => {
  let bytes = 0;
  let at = end;
  while (at > 0) {
    const low = text.charCodeAt(at - 1);
    const units = low >= 0xdc00 && low <= 0xdfff && at >= 2 ? 2 : 1;
    const size = bytesOfCode(text.codePointAt(at - units) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    at -= units;
  }
  return at;
};

export const endWithinBytes = (text: string, from: number, stop: number, maxBytes: number): number => {
  let bytes = 0;
  let at = from;
  while (at < stop) {
    const size = bytesOfCode(text.codePointAt(at) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    at += unitsAt(text, at);
  }
  return at === from && from < stop ? from + unitsAt(text, from) : at;
};

export type OutputTail = { lines: readonly string[]; hidden: number };

export const tailOf = (output: string): OutputTail | undefined => {
  const end = output.endsWith('\n') ? output.length - 1 : output.length;
  if (end === 0) return undefined;
  const from = startWithinBytes(output, end, OUTPUT_TAIL_MAX_BYTES);
  const within = output.slice(from, end).split('\n');
  const kept = within.slice(-OUTPUT_TAIL_LINES);
  let total = 1;
  for (let at = output.indexOf('\n'); at !== -1 && at < end; at = output.indexOf('\n', at + 1)) total += 1;
  const lines = from > 0 && kept.length === within.length ? [`${ELLIPSIS}${kept[0] ?? ''}`, ...kept.slice(1)] : kept;
  return { lines, hidden: total - lines.length };
};
