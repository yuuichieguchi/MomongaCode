export const renderInstancePath = (segments: readonly string[]): string => {
  if (segments.length === 0) return '(root)';
  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
};

const fieldOf = (value: unknown, text: string, segments: readonly string[]): readonly string[] | undefined => {
  if (value === text) return segments;
  if (typeof value !== 'object' || value === null) return undefined;
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  for (const [key, item] of entries) {
    if (!Array.isArray(value) && key === text) return [...segments, key];
    const found = fieldOf(item, text, [...segments, key]);
    if (found !== undefined) return found;
  }
  return undefined;
};

const secondsText = (limitMs: number): string => {
  const seconds = limitMs / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
};

export const patternRefusal = (subject: string, data: unknown, notChecked: { readonly input: string; readonly limitMs: number }): string => {
  const field = fieldOf(data, notChecked.input, []);
  if (field === undefined) throw new Error(`the text a pattern was matched against is not in ${subject}`);
  return `The ${subject} could not be checked against its schema within ${secondsText(notChecked.limitMs)}: the pattern of ${renderInstancePath(field)} is too costly to match.`;
};
