import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { CredentialStore } from './credential-store.ts';
import { isRecord } from './json.ts';
import { OAuthAuthorizationError } from './oauth-authorization-error.ts';

const CLIENT_NAME = 'MomongaCode';
const STORE_VERSION = 1;
const PASSIVE_REDIRECT_URL = 'http://127.0.0.1/callback';

type IssuerCredentials = { clientInformation?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens };

type StoredCredentials = { version: typeof STORE_VERSION; lastIssuer?: string; issuers: Record<string, IssuerCredentials> };


const parseStored = (raw: string): StoredCredentials => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed['version'] !== STORE_VERSION || !isRecord(parsed['issuers'])) {
    throw new Error('stored credentials have an unrecognised shape');
  }
  const issuers: Record<string, IssuerCredentials> = {};
  for (const [issuer, entry] of Object.entries(parsed['issuers'])) {
    if (!isRecord(entry)) throw new Error('stored credentials have an unrecognised issuer entry');
    const tokens = entry['tokens'];
    const client = entry['clientInformation'];
    if (tokens !== undefined && !(isRecord(tokens) && typeof tokens['access_token'] === 'string' && typeof tokens['token_type'] === 'string')) {
      throw new Error('stored tokens have an unrecognised shape');
    }
    if (client !== undefined && !(isRecord(client) && typeof client['client_id'] === 'string')) {
      throw new Error('stored client information has an unrecognised shape');
    }
    issuers[issuer] = {
      ...(tokens === undefined ? {} : { tokens: tokens as StoredOAuthTokens }),
      ...(client === undefined ? {} : { clientInformation: client as StoredOAuthClientInformation }),
    };
  }
  const lastIssuer = parsed['lastIssuer'];
  return { version: STORE_VERSION, issuers, ...(typeof lastIssuer === 'string' ? { lastIssuer } : {}) };
};

export type OAuthProviderOptions = {
  key: string;
  subject: string;
  store: CredentialStore;
  signal: AbortSignal;
  redirectUrl: string | undefined;
  randomToken(): string;
  preregisteredClientId?: string;
  requestedScope?: string;
  onAuthorizationUrl(url: URL): void;
  onSecret?(value: string): void;
  authorizationParams?(url: URL): Record<string, string>;
  acceptTokens?(response: StoredOAuthTokens): void | Promise<void>;
};

export type OAuthProvider = OAuthClientProvider & {
  readonly expectedState: string | undefined;
  readonly recordedIssuer: { issuer: string; issParameterSupported: boolean } | undefined;
  secretValues(): Promise<string[]>;
};

const emptyStored = (): StoredCredentials => ({ version: STORE_VERSION, issuers: {} });

export const createOAuthProvider = (options: OAuthProviderOptions): OAuthProvider => {
  const { key } = options;
  let verifier: string | undefined;
  let state: string | undefined;
  let discovered: { issuer: string; issParameterSupported: boolean } | undefined;
  let discoveryState: OAuthDiscoveryState | undefined;

  const load = async (): Promise<StoredCredentials> => {
    const raw = await options.store.read(key, options.signal);
    return raw === undefined ? emptyStored() : parseStored(raw);
  };
  const update = async (issuer: string | undefined, change: (entry: IssuerCredentials) => IssuerCredentials): Promise<void> => {
    await options.store.update(key, (raw) => {
      const stored = raw === undefined ? emptyStored() : parseStored(raw);
      const target = issuer ?? stored.lastIssuer;
      if (target === undefined) throw new Error('cannot store credentials without an authorization server issuer');
      stored.issuers[target] = change(stored.issuers[target] ?? {});
      stored.lastIssuer = target;
      return JSON.stringify(stored);
    }, options.signal);
  };
  const entryFor = async (context: OAuthClientInformationContext | undefined): Promise<IssuerCredentials | undefined> => {
    const stored = await load();
    const issuer = context?.issuer ?? stored.lastIssuer;
    return issuer === undefined ? undefined : stored.issuers[issuer];
  };

  const authorizationRequired = (): OAuthAuthorizationError =>
    new OAuthAuthorizationError('required', `${options.subject} requires authorization and has no valid credentials`);

  const reveal = (...values: Array<string | undefined>): void => {
    for (const value of values) if (value !== undefined && value !== '') options.onSecret?.(value);
  };

  return {
    get redirectUrl() {
      return options.redirectUrl ?? PASSIVE_REDIRECT_URL;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: CLIENT_NAME,
        redirect_uris: [options.redirectUrl ?? PASSIVE_REDIRECT_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        ...(options.requestedScope === undefined ? {} : { scope: options.requestedScope }),
      };
    },
    get expectedState() {
      return state;
    },
    get recordedIssuer() {
      return discovered;
    },
    state: () => {
      state = options.randomToken();
      return state;
    },
    clientInformation: async (context) => {
      const stored = (await entryFor(context))?.clientInformation;
      if (stored !== undefined) return stored;
      if (options.preregisteredClientId !== undefined) return { client_id: options.preregisteredClientId };
      if (options.redirectUrl === undefined) throw authorizationRequired();
      return undefined;
    },
    saveClientInformation: async (information, context) => {
      reveal((information as { client_secret?: string }).client_secret);
      await update(context?.issuer, (entry) => ({ ...entry, clientInformation: information }));
    },
    tokens: async (context) => {
      const tokens = (await entryFor(context))?.tokens;
      reveal(tokens?.access_token, tokens?.refresh_token);
      return tokens;
    },
    saveTokens: async (tokens, context) => {
      reveal(tokens.access_token, tokens.refresh_token);
      await options.acceptTokens?.(tokens);
      await update(context?.issuer, (entry) => ({ ...entry, tokens }));
    },
    redirectToAuthorization: (url) => {
      if (options.redirectUrl === undefined) throw authorizationRequired();
      if (options.authorizationParams === undefined) {
        options.onAuthorizationUrl(url);
        return;
      }
      const extended = new URL(url);
      for (const [name, value] of Object.entries(options.authorizationParams(url))) {
        if (extended.searchParams.has(name)) throw new Error(`authorization parameter "${name}" is already set`);
        extended.searchParams.set(name, value);
      }
      options.onAuthorizationUrl(extended);
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => {
      if (verifier === undefined) throw new OAuthAuthorizationError('invalid_callback', 'no authorization is in progress');
      return verifier;
    },
    discoveryState: () => discoveryState,
    saveDiscoveryState: (value: OAuthDiscoveryState) => {
      discoveryState = value;
      const metadata = value.authorizationServerMetadata;
      if (metadata !== undefined) {
        discovered = {
          issuer: metadata.issuer,
          issParameterSupported: (metadata as { authorization_response_iss_parameter_supported?: boolean }).authorization_response_iss_parameter_supported === true,
        };
      }
    },
    invalidateCredentials: async (scope) => {
      if (scope === 'verifier') {
        verifier = undefined;
        return;
      }
      if (scope === 'discovery') {
        discovered = undefined;
        discoveryState = undefined;
        return;
      }
      if (scope === 'all') {
        await options.store.remove(key, options.signal);
        return;
      }
      await options.store.update(key, (raw) => {
        const stored = raw === undefined ? emptyStored() : parseStored(raw);
        for (const entry of Object.values(stored.issuers)) {
          if (scope === 'tokens') delete entry.tokens;
          if (scope === 'client') delete entry.clientInformation;
        }
        return JSON.stringify(stored);
      }, options.signal);
    },
    secretValues: async () => {
      const stored = await load();
      return Object.values(stored.issuers).flatMap((entry) => {
        const values = [entry.tokens?.access_token, entry.tokens?.refresh_token, (entry.clientInformation as { client_secret?: string } | undefined)?.client_secret];
        return values.filter((value): value is string => typeof value === 'string' && value !== '');
      });
    },
  };
};
