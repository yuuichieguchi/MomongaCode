export type CodeRange = readonly [first: number, last: number];

export type CharSet = readonly CodeRange[];

export const normalizeSet = (ranges: readonly CodeRange[]): CharSet => {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [first, last] of sorted) {
    const tail = merged[merged.length - 1];
    if (tail !== undefined && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last);
    else merged.push([first, last]);
  }
  return merged;
};

export const unionSets = (...sets: readonly CharSet[]): CharSet => normalizeSet(sets.flat());

export const subtractSets = (from: CharSet, removed: CharSet): CharSet => {
  const result: Array<[number, number]> = [];
  for (const [first, last] of from) {
    let cursor = first;
    for (const [removedFirst, removedLast] of normalizeSet(removed)) {
      if (removedLast < cursor || removedFirst > last) continue;
      if (removedFirst > cursor) result.push([cursor, removedFirst - 1]);
      cursor = Math.max(cursor, removedLast + 1);
    }
    if (cursor <= last) result.push([cursor, last]);
  }
  return normalizeSet(result);
};

export const intersectSets = (left: CharSet, right: CharSet): CharSet => subtractSets(left, subtractSets(left, right));

export const setContains = (set: CharSet, codePoint: number): boolean => set.some(([first, last]) => first <= codePoint && codePoint <= last);

export const singleton = (codePoint: number): CharSet => [[codePoint, codePoint]];

export const isEmptySet = (set: CharSet): boolean => set.length === 0;

const PRINTABLE_ASCII: CharSet = [[0x20, 0x7e]];

export const alphabetFor = (texts: readonly string[]): CharSet => {
  const extra: CodeRange[] = [];
  for (const text of texts) {
    for (const character of text.normalize('NFC')) {
      const codePoint = character.codePointAt(0) as number;
      if (codePoint > 0x7e) extra.push([codePoint, codePoint]);
    }
  }
  return unionSets(PRINTABLE_ASCII, extra);
};

const caseVariantsOf = (codePoint: number): number[] => {
  const character = String.fromCodePoint(codePoint);
  const variants = new Set<number>([codePoint]);
  for (const candidate of [character.toLowerCase(), character.toUpperCase()]) {
    if ([...candidate].length === 1) variants.add(candidate.codePointAt(0) as number);
  }
  return [...variants];
};

export const foldCase = (set: CharSet): CharSet => {
  const extra: CodeRange[] = [];
  for (const [first, last] of set) {
    for (let codePoint = first; codePoint <= last; codePoint += 1) {
      for (const variant of caseVariantsOf(codePoint)) extra.push([variant, variant]);
    }
  }
  return unionSets(set, extra);
};
