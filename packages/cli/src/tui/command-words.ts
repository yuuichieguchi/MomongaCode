export type CommandWords = { readonly kind: 'words'; readonly words: readonly string[] } | { readonly kind: 'refused'; readonly reason: string };

const SINGLE = "'";
const DOUBLE = '"';
const ESCAPE = '\\';
const ESCAPED_IN_DOUBLE: readonly string[] = [DOUBLE, ESCAPE, '$', '`'];
const BLANK = /\s/;

export const unclosedQuoteReason = (quote: string): string => `the line has an unclosed ${quote} quote`;

export const commandWords = (line: string): CommandWords => {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quote === SINGLE) {
      if (character === SINGLE) quote = undefined;
      else word += character;
    } else if (quote === DOUBLE) {
      const next = line.charAt(index + 1);
      if (character === DOUBLE) quote = undefined;
      else if (character === ESCAPE && ESCAPED_IN_DOUBLE.includes(next)) {
        word += next;
        index += 1;
      } else word += character;
    } else if (character === SINGLE || character === DOUBLE) {
      quote = character;
      started = true;
    } else if (character === ESCAPE && index + 1 < line.length) {
      word += line.charAt(index + 1);
      started = true;
      index += 1;
    } else if (BLANK.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote !== undefined) return { kind: 'refused', reason: unclosedQuoteReason(quote) };
  if (started) words.push(word);
  return { kind: 'words', words };
};
