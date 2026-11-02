const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export const safeSlice = (text: string, start: number, end: number): string => {
  let from = start;
  let to = Math.min(end, text.length);
  if (from > 0 && from < to && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) from += 1;
  if (to < text.length && to > from && isHighSurrogate(text.charCodeAt(to - 1)) && isLowSurrogate(text.charCodeAt(to))) to -= 1;
  return text.slice(from, to);
};
