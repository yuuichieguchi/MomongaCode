class BraceOverflow extends Error {}

const NUMERIC_SEQUENCE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
const LETTER_SEQUENCE = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/;

const closingBrace = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '\\') index += 1;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const splitTopLevel = (body: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === '\\') index += 1;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
};

const sequenceOf = (body: string, limit: number): string[] | undefined => {
  const numeric = NUMERIC_SEQUENCE.exec(body);
  const letters = LETTER_SEQUENCE.exec(body);
  const match = numeric ?? letters;
  if (match === null) return undefined;
  const first = numeric !== null ? Number(match[1]) : (match[1] as string).charCodeAt(0);
  const last = numeric !== null ? Number(match[2]) : (match[2] as string).charCodeAt(0);
  const step = Math.max(1, Math.abs(Number(match[3] ?? 1)));
  const digits = [match[1], match[2]].map((end) => (end as string).replace('-', ''));
  const width = numeric !== null && digits.some((end) => end.length > 1 && end.startsWith('0')) ? Math.max(...digits.map((end) => end.length)) : 0;
  const render = (value: number): string => {
    if (numeric === null) return String.fromCharCode(value);
    const sign = value < 0 ? '-' : '';
    return `${sign}${String(Math.abs(value)).padStart(width, '0')}`;
  };
  const values: string[] = [];
  for (let value = first; first <= last ? value <= last : value >= last; value += first <= last ? step : -step) {
    if (values.length >= limit) throw new BraceOverflow();
    values.push(render(value));
  }
  return values;
};

const expandWithin = (text: string, limit: number): string[] => {
  for (let open = text.indexOf('{'); open !== -1; open = text.indexOf('{', open + 1)) {
    if (open > 0 && text.charAt(open - 1) === '\\') continue;
    const close = closingBrace(text, open);
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    const parts = splitTopLevel(body);
    const items = parts.length > 1 ? parts.flatMap((part) => expandWithin(part, limit)) : sequenceOf(body, limit);
    if (items === undefined) continue;
    const prefix = text.slice(0, open);
    const suffixes = expandWithin(text.slice(close + 1), limit);
    if (items.length * suffixes.length > limit) throw new BraceOverflow();
    return items.flatMap((item) => suffixes.map((suffix) => `${prefix}${item}${suffix}`));
  }
  return [text];
};

export const expandBraces = (pattern: string, limit: number): string[] | 'overflow' => {
  try {
    const expanded = expandWithin(pattern, limit);
    return expanded.length > limit ? 'overflow' : expanded;
  } catch (error) {
    if (error instanceof BraceOverflow) return 'overflow';
    throw error;
  }
};
