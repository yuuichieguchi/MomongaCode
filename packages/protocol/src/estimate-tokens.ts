import { ESTIMATED_CHARACTERS_PER_TOKEN } from './characters-per-token.ts';

const ALPHABETIC_CHARACTERS_PER_TOKEN = 2;
const ALPHABETIC_CHARACTER = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;
const NARROW_CHARACTER = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const PER_CHARACTER_EXCEPTION = /\p{Extended_Pictographic}|[　-〿＀-￯]/u;
const FIRST_NON_ASCII = 0x80;
const FIRST_ASTRAL = 0x10000;

type ScriptClass = 'narrow' | 'alphabetic' | 'per_character';

const scriptClassOf = (codePoint: number): ScriptClass => {
  if (codePoint < FIRST_NON_ASCII) return 'narrow';
  const character = String.fromCodePoint(codePoint);
  if (PER_CHARACTER_EXCEPTION.test(character)) return 'per_character';
  if (NARROW_CHARACTER.test(character)) return 'narrow';
  return ALPHABETIC_CHARACTER.test(character) ? 'alphabetic' : 'per_character';
};

export class TokenTally {
  private narrowUnits = 0;
  private alphabeticCharacters = 0;
  private perCharacter = 0;

  add(text: string): void {
    for (let index = 0; index < text.length; ) {
      const codePoint = text.codePointAt(index) as number;
      const units = codePoint >= FIRST_ASTRAL ? 2 : 1;
      const scriptClass = scriptClassOf(codePoint);
      if (scriptClass === 'narrow') this.narrowUnits += units;
      else if (scriptClass === 'alphabetic') this.alphabeticCharacters += 1;
      else this.perCharacter += 1;
      index += units;
    }
  }

  get tokens(): number {
    return Math.max(
      1,
      Math.ceil(this.narrowUnits / ESTIMATED_CHARACTERS_PER_TOKEN) + Math.ceil(this.alphabeticCharacters / ALPHABETIC_CHARACTERS_PER_TOKEN) + this.perCharacter,
    );
  }
}

export const tokensForText = (text: string): number => {
  const tally = new TokenTally();
  tally.add(text);
  return tally.tokens;
};
