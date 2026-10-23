const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|PASSPHRASE|CREDS)|(^|_)PASS(_|$)|.+_PWD$/i;

const KEPT_NAMES: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'SSH_AUTH_SOCK', 'TERM_SESSION_ID', 'SECURITYSESSIONID', 'GPG_TTY']);

const KEPT_PREFIXES = ['XDG_SESSION_', 'GIT_AUTHOR_', 'GIT_COMMITTER_'] as const;

const TOKEN_PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'github_pat_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'] as const;

const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]*:[^/?#@\s]+@/i;

const AWS_ACCESS_KEY_ID = /^AKIA[0-9A-Z]{16}$/;

export const looksLikeCredentialName = (name: string): boolean => CREDENTIAL_NAME.test(name);

export const isCredentialEnvName = (name: string): boolean =>
  looksLikeCredentialName(name) && !KEPT_NAMES.has(name) && !KEPT_PREFIXES.some((prefix) => name.startsWith(prefix));

const isCredentialEnvValue = (value: string): boolean =>
  URL_WITH_PASSWORD.test(value) || TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix)) || AWS_ACCESS_KEY_ID.test(value);

export const stripCredentialEnv = (
  env: Readonly<Record<string, string>>,
  declaredNames: readonly string[],
): { env: Record<string, string>; removed: string[] } => {
  const declared = new Set(declaredNames);
  const kept: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (declared.has(name) || isCredentialEnvName(name) || isCredentialEnvValue(value)) removed.push(name);
    else kept[name] = value;
  }
  return { env: kept, removed: removed.sort() };
};
