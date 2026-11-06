export const FIDELITY_CLAIMS = ['executed', 'any'] as const;

export type FidelityClaim = (typeof FIDELITY_CLAIMS)[number];

export type ClaimedToken = { readonly token: string; readonly claim: FidelityClaim };

export type TokenMatcher = {
  readonly span: number;
  matches(text: string, complete: boolean): boolean;
};

const PATH_CHARACTER = /[\w@%+=,.-]/;
const CONTINUES_PATH = /[\w@%+=-]/;
const WORD_CHARACTER = /\w/;
const WHITESPACE = /\s/;
const SEPARATOR = /[/\\]/;
const LEADING_CURRENT_DIRECTORY = /^(?:\.\/)+/;

const forwardSlashes = (text: string): string => text.replaceAll('\\', '/');

export const isPathLikeToken = (token: string): boolean => SEPARATOR.test(token) && !WHITESPACE.test(token);

export const reducedPathToken = (token: string, cwd: string): string => {
  const slashed = forwardSlashes(token);
  const root = forwardSlashes(cwd).replace(/\/+$/, '');
  const relative = root !== '' && slashed.startsWith(`${root}/`) ? slashed.slice(root.length + 1) : slashed;
  return relative.replace(LEADING_CURRENT_DIRECTORY, '');
};

const endsAtBoundary = (text: string, end: number): boolean => {
  const next = text.charAt(end);
  return !CONTINUES_PATH.test(next) && !(next === '.' && WORD_CHARACTER.test(text.charAt(end + 1)));
};

const occursAtBoundary = (needle: string, text: string, complete: boolean): boolean => {
  for (let from = text.indexOf(needle); from >= 0; from = text.indexOf(needle, from + 1)) {
    const end = from + needle.length;
    if (end === text.length) {
      if (complete && (from === 0 || !PATH_CHARACTER.test(text.charAt(from - 1)))) return true;
      continue;
    }
    if ((from === 0 || !PATH_CHARACTER.test(text.charAt(from - 1))) && endsAtBoundary(text, end)) return true;
  }
  return false;
};

export const tokenMatcherOf = (token: string, cwd: string): TokenMatcher => {
  if (isPathLikeToken(token)) {
    const needle = reducedPathToken(token, cwd);
    return { span: needle.length + 1, matches: (text, complete) => occursAtBoundary(needle, forwardSlashes(text), complete) };
  }
  const needle = forwardSlashes(token);
  return { span: needle.length + 1, matches: (text) => forwardSlashes(text).includes(needle) };
};
