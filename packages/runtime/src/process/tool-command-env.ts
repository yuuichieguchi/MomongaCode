import { credentialNamesOf, stripCredentialEnv } from '@momonga/config';
import type { CredentialNaming, CredentialRules } from '@momonga/config';
import { bashEnvOf } from '@momonga/tools';

export type ToolCommandCredentials = CredentialNaming & { credentials: CredentialRules };

const definedEntries = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const toolCommandEnvOf = (env: Readonly<Record<string, string | undefined>>, naming: ToolCommandCredentials): Record<string, string> =>
  bashEnvOf(stripCredentialEnv(definedEntries(env), credentialNamesOf(naming), naming.credentials).env);
