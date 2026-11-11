import { credentialEnvNames, credentialNamesOf, forgeCredentialNamesOf, stripCredentialEnv } from '@momonga/config';
import type { CredentialNaming, CredentialRules } from '@momonga/config';
import { MINIMAL_CHILD_ENV_LC_PREFIX, MINIMAL_CHILD_ENV_NAMES, NETWORK_ENV_NAMES, layoutEnvOf, minimalChildEnv, secretStoreEnvFor } from '@momonga/foundation';

export type CredentialSettings = CredentialNaming & { credentials?: CredentialRules };

export type SourceEnv = Readonly<Record<string, string | undefined>>;

export const COLLIDING_CREDENTIAL_PREFIXES: readonly string[] = [MINIMAL_CHILD_ENV_LC_PREFIX, 'NODE_', 'LD_', 'DYLD_'];

export const COLLIDING_CREDENTIAL_DETAIL = 'declared credential variable collides with the minimal child environment';

const MINIMAL_NAMES: ReadonlySet<string> = new Set(MINIMAL_CHILD_ENV_NAMES);

const collidesWithMinimalEnv = (name: string): boolean => MINIMAL_NAMES.has(name) || COLLIDING_CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix));

export const definedEnv = (env: SourceEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const handedCredentialNames = (settings: CredentialSettings): readonly string[] => credentialEnvNames(settings.models).filter((name) => !collidesWithMinimalEnv(name));

export const gatewayEnv = (env: SourceEnv, settings: CredentialSettings, home: string, onSkipped: (name: string) => void = () => undefined): Record<string, string> => {
  const source = definedEnv(env);
  const result: Record<string, string> = {};
  for (const name of credentialEnvNames(settings.models)) {
    if (collidesWithMinimalEnv(name)) {
      onSkipped(name);
      continue;
    }
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  Object.assign(result, minimalChildEnv(source));
  Object.assign(result, secretStoreEnvFor(source));
  Object.assign(result, layoutEnvOf(source));
  if (source['HOME'] === undefined) result['HOME'] = home;
  for (const name of NETWORK_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
};

export const runtimeEnv = (env: SourceEnv, settings: CredentialSettings): { env: Record<string, string>; removed: string[] } => {
  const source = definedEnv(env);
  const stripped = stripCredentialEnv(source, credentialNamesOf(settings), settings.credentials);
  const forgeCredentials: Record<string, string> = {};
  for (const name of forgeCredentialNamesOf(settings)) {
    const value = source[name];
    if (value !== undefined && !collidesWithMinimalEnv(name)) forgeCredentials[name] = value;
  }
  return { env: { ...stripped.env, ...forgeCredentials, ...secretStoreEnvFor(source) }, removed: stripped.removed.filter((name) => !(name in forgeCredentials)) };
};
