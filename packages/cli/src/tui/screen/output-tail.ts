export const OUTPUT_TAIL_MAX_BYTES = 8 * 1024;
export const OUTPUT_TAIL_LINES = 5;

export const ELLIPSIS = '…';
const LOW_SURROGATE = /^[\uDC00-\uDFFF]/;

export type OutputTail = { lines: readonly string[]; hidden: number };

export const tailOf = (output: string): OutputTail | undefined => {
  const end = output.endsWith('\n') ? output.length - 1 : output.length;
  if (end === 0) return undefined;
  const start = Math.max(0, end - OUTPUT_TAIL_MAX_BYTES);
  const from = LOW_SURROGATE.test(output.charAt(start)) ? start + 1 : start;
  const within = output.slice(from, end).split('\n');
  const kept = within.slice(-OUTPUT_TAIL_LINES);
  let total = 1;
  for (let at = output.indexOf('\n'); at !== -1 && at < end; at = output.indexOf('\n', at + 1)) total += 1;
  const lines = from > 0 && kept.length === within.length ? [`${ELLIPSIS}${kept[0] ?? ''}`, ...kept.slice(1)] : kept;
  return { lines, hidden: total - lines.length };
};
