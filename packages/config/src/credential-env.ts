import { credentialEnvNames } from './models.ts';
import type { ResolvedModels } from './models.ts';

export type CredentialRules = { env?: readonly string[]; keep?: readonly string[]; valuePatterns?: readonly string[] };

const STRONG_WORD = /KEY|TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|CREDENTIAL|CREDS/i;

const WEAK_WORDS: ReadonlySet<string> = new Set(['AUTH', 'COOKIE', 'SESSION', 'PRIVATE', 'PASS', 'URL', 'DSN', 'CONN', 'PAT']);

const LAST_WORD_ONLY = 'PWD';

const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]*:[^/?#@\s]+@/i;

export const looksLikeCredentialName = (name: string): boolean => {
  if (STRONG_WORD.test(name)) return true;
  const words = name.toUpperCase().split('_');
  return words.some((word) => WEAK_WORDS.has(word)) || (words.length > 1 && words.at(-1) === LAST_WORD_ONLY);
};

export const isCredentialEnvName = looksLikeCredentialName;

export type CredentialNaming = { models: Pick<ResolvedModels, 'connections'>; forges?: readonly { credential: { env: string } | { secret: string } }[] | undefined };

export const forgeCredentialNamesOf = (settings: Pick<CredentialNaming, 'forges'>): string[] =>
  [...new Set((settings.forges ?? []).flatMap((forge) => ('env' in forge.credential ? [forge.credential.env] : [])))].sort();

export const credentialNamesOf = (settings: CredentialNaming): string[] => [...new Set([...credentialEnvNames(settings.models), ...forgeCredentialNamesOf(settings)])].sort();

const globOf = (glob: string): RegExp => new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

export const stripCredentialEnv = (
  env: Readonly<Record<string, string>>,
  declaredNames: readonly string[],
  credentials: CredentialRules = {},
): { env: Record<string, string>; removed: string[] } => {
  const declaredExact = new Set(declaredNames);
  const declaredGlobs = (credentials.env ?? []).map(globOf);
  const valuePatterns = (credentials.valuePatterns ?? []).map((pattern) => new RegExp(pattern));
  const kept = new Set(credentials.keep ?? []);
  const isDeclared = (name: string): boolean => declaredExact.has(name) || declaredGlobs.some((glob) => glob.test(name));
  const isWithheldDirectly = (name: string, value: string): boolean =>
    isDeclared(name) || (!kept.has(name) && (URL_WITH_PASSWORD.test(value) || valuePatterns.some((pattern) => pattern.test(value)) || looksLikeCredentialName(name)));
  const entries = Object.entries(env);
  const withheldValues = new Set(entries.filter(([name, value]) => isWithheldDirectly(name, value)).map(([, value]) => value));
  const result: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of entries) {
    if (withheldValues.has(value)) removed.push(name);
    else result[name] = value;
  }
  return { env: result, removed: removed.sort() };
};
