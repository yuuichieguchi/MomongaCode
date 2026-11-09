import { MIN_CREDENTIAL_CHARS } from '@momonga/foundation';
import { COMMON_PASSWORDS_TEXT } from './common-passwords.data.ts';

let commonPasswords: ReadonlySet<string> | undefined;

const commonPasswordSet = (): ReadonlySet<string> => {
  commonPasswords ??= new Set(COMMON_PASSWORDS_TEXT.split('\n'));
  return commonPasswords;
};

export const COMMON_PASSWORD_LIST: { readonly source: string; readonly version: string; readonly size: number } = {
  source: 'SecLists Passwords/Common-Credentials/10k-most-common.txt (https://github.com/danielmiessler/SecLists), MIT License',
  version: '913b327317496d062bcc7cace524aaad8a693be2',
  get size(): number {
    return commonPasswordSet().size;
  },
};

export const MIN_HIDDEN_CREDENTIAL_CHARS = MIN_CREDENTIAL_CHARS;

export type CredentialJudgement = { common: boolean; short: boolean };

export const judgeCredential = (value: string): CredentialJudgement => ({
  common: commonPasswordSet().has(value),
  short: value.length < MIN_HIDDEN_CREDENTIAL_CHARS,
});

export const credentialNoticesOf = (server: string, label: string, value: string): string[] => {
  const judgement = judgeCredential(value);
  return [
    ...(judgement.common ? [`MCP server "${server}": the credential ${label} could be guessed: it is one of the most commonly used values. Tool output is redacted, but a guessable value can still be found by trial.`] : []),
    ...(judgement.short ? [`MCP server "${server}": the credential ${label} is too short to hide: values under ${MIN_HIDDEN_CREDENTIAL_CHARS} characters are not redacted from tool output.`] : []),
  ];
};
