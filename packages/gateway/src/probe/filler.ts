const FILLER_SEED = 0x5eed1234;

const NOUNS = [
  'river', 'garden', 'lantern', 'harbor', 'orchard', 'violin', 'bridge', 'meadow', 'compass', 'library', 'village', 'window', 'mountain', 'kitchen', 'carpenter', 'sailor',
  'teacher', 'painter', 'market', 'station', 'blanket', 'journey', 'forest', 'letter', 'engine', 'candle', 'valley', 'lighthouse', 'festival', 'bakery', 'telescope', 'canal',
  'barn', 'quilt', 'anchor', 'ladder', 'fountain', 'notebook', 'shepherd', 'glacier', 'workshop', 'carriage', 'island', 'tower', 'pottery', 'garment', 'staircase', 'courtyard',
  'furnace', 'mirror', 'basket', 'chimney', 'cottage', 'footpath', 'pasture', 'ferry', 'museum', 'orchestra', 'lantern-maker', 'weaver', 'trail', 'pond', 'granary', 'cellar',
] as const;

const ADJECTIVES = [
  'quiet', 'old', 'bright', 'narrow', 'gentle', 'crowded', 'distant', 'warm', 'wooden', 'patient', 'curious', 'steady', 'faded', 'generous', 'sturdy', 'hidden',
  'peaceful', 'weathered', 'cheerful', 'ancient', 'modest', 'restless', 'golden', 'silent', 'careful', 'humble', 'sunlit', 'rugged', 'tidy', 'spacious', 'fragrant', 'ordinary',
  'lively', 'sheltered', 'remote', 'familiar', 'elegant', 'simple', 'windswept', 'cozy', 'thoughtful', 'vivid', 'dusty', 'graceful', 'rustic', 'lonely', 'busy', 'misty',
  'polished', 'shaded', 'timeless', 'friendly', 'frozen', 'verdant', 'handmade', 'seasonal', 'remarkable', 'plain', 'spirited', 'tranquil', 'worn', 'cool', 'broad', 'slender',
] as const;

const VERBS = [
  'watched', 'remembered', 'visited', 'repaired', 'described', 'followed', 'admired', 'carried', 'painted', 'measured', 'welcomed', 'answered', 'noticed', 'cleaned', 'explored', 'guided',
  'sketched', 'gathered', 'protected', 'photographed', 'greeted', 'studied', 'borrowed', 'polished', 'crossed', 'shared', 'recorded', 'arranged', 'inspected', 'rebuilt', 'celebrated', 'delivered',
  'considered', 'collected', 'discovered', 'prepared', 'trusted', 'unlocked', 'mapped', 'tended', 'lifted', 'surveyed', 'praised', 'recalled', 'sorted', 'traced', 'steadied', 'chose',
  'reached', 'opened', 'folded', 'spotted', 'taught', 'remade', 'cherished', 'escorted', 'lit', 'balanced', 'stirred', 'saved', 'pictured', 'counted', 'handled', 'mended',
] as const;

const ADVERBS = [
  'slowly', 'carefully', 'early', 'happily', 'quietly', 'patiently', 'twice', 'gladly', 'calmly', 'eagerly', 'gently', 'often', 'rarely', 'briefly', 'warmly', 'thoroughly',
  'cheerfully', 'faithfully', 'promptly', 'silently', 'steadily', 'proudly', 'lightly', 'daily', 'kindly', 'seriously', 'humbly', 'openly', 'swiftly', 'curiously', 'tenderly', 'dutifully',
] as const;

const TIMES = [
  'at dawn', 'after the rain', 'before supper', 'in early spring', 'during the festival', 'late in autumn', 'on a windy morning', 'through the long winter', 'at midday', 'under a pale moon',
  'every summer', 'once a week', 'in the evening', 'after the harvest', 'as the fog lifted', 'on market day', 'before the storm', 'just after sunrise', 'at the turn of the year', 'while the town slept',
] as const;

const PLACES = [
  'near', 'beside', 'behind', 'beyond', 'across from', 'along', 'above', 'below', 'inside', 'outside', 'toward', 'around',
] as const;

type Pick = <T>(items: readonly T[]) => T;

const generatorFor = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const SENTENCES: ReadonlyArray<(pick: Pick) => string> = [
  (pick) => `The ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(VERBS)} the ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(TIMES)}.`,
  (pick) => `A ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(PLACES)} the ${pick(NOUNS)} ${pick(VERBS)} ${pick(ADVERBS)} ${pick(TIMES)}.`,
  (pick) => `${pick(TIMES).replace(/^./, (letter) => letter.toUpperCase())}, the ${pick(NOUNS)} ${pick(VERBS)} a ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(PLACES)} the ${pick(NOUNS)}.`,
  (pick) => `Everyone said the ${pick(NOUNS)} ${pick(ADVERBS)} ${pick(VERBS)} every ${pick(ADJECTIVES)} ${pick(NOUNS)}, and the ${pick(NOUNS)} ${pick(VERBS)} it too.`,
  (pick) => `Nobody ${pick(VERBS)} the ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(PLACES)} the ${pick(ADJECTIVES)} ${pick(NOUNS)} as ${pick(ADVERBS)} as the ${pick(NOUNS)}.`,
  (pick) => `Her ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(VERBS)} two ${pick(ADJECTIVES)} ${pick(NOUNS)}s ${pick(TIMES)}, and then ${pick(VERBS)} the ${pick(NOUNS)}.`,
];

export const fillerText = (wordCount: number): string => {
  const next = generatorFor(FILLER_SEED);
  const pick: Pick = (items) => {
    const chosen = items[Math.floor(next() * items.length)];
    if (chosen === undefined) throw new Error('filler word list is empty');
    return chosen;
  };
  const words: string[] = [];
  while (words.length < wordCount) {
    const template = SENTENCES[Math.floor(next() * SENTENCES.length)];
    if (template === undefined) throw new Error('filler sentence list is empty');
    words.push(...template(pick).split(' '));
  }
  words.length = wordCount;
  const last = words.at(-1);
  if (last !== undefined && !last.endsWith('.')) words[words.length - 1] = `${last.replace(/[,]$/, '')}.`;
  return words.join(' ');
};
