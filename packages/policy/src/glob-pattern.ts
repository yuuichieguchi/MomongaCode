const UNESCAPED_LITERAL = /[^A-Za-z0-9_/.-]/g;
const ESCAPED_CHARACTER = /\\([\s\S])/g;

export const escapeForGlob = (text: string): string => text.replace(UNESCAPED_LITERAL, '\\$&');

export const unescapeGlob = (pattern: string): string => pattern.replace(ESCAPED_CHARACTER, '$1');

export const firstUnescaped = (pattern: string, characters: string): number => {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '\\') index += 1;
    else if (characters.includes(char)) return index;
  }
  return -1;
};

export const GLOB_CHARACTERS = '*?[';
export const GLOB_OR_BRACE_CHARACTERS = '*?[]{}';
