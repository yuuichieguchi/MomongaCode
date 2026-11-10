import { createHash, createHmac, createSign, generateKeyPair, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type http from 'node:http';
import { promisify } from 'node:util';
import { createCanary } from './canary-tokens.ts';
import { readBody, sendJson, startLoopbackServer } from './loopback-http.ts';
import type { LoopbackServer } from './loopback-http.ts';

export const SIWC_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';

export const SIWC_CALLBACK_PATH = '/auth/callback';

export const SIWC_RESOURCE = 'https://api.openai.com/v1';

export const SIWC_FULL_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export const SIWC_REFRESH_ERRORS = {
  unusable: ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'],
  invalidClient: ['invalid_client'],
} as const;

const AUTHORIZE_PATH = '/api/accounts/authorize';
const TOKEN_PATH = '/api/accounts/oauth/token';
const REVOKE_PATH = '/api/accounts/oauth/revoke';
const JWKS_PATH = '/.well-known/jwks.json';
const DISCOVERY_PATH = '/.well-known/openid-configuration';

const ACCESS_TOKEN_SECONDS = 3600;

const RSA_MODULUS_BITS = 2048;

export type SiwcAuthorizeMode = 'approve' | 'access_denied' | 'foreign_client_id' | 'wrong_state' | 'replayed_code' | 'omit_client_id';

export type SiwcIdTokenFlaw =
  | 'forged_signature'
  | 'unknown_kid'
  | 'alg_none'
  | 'wrong_alg'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'wrong_nonce'
  | 'missing_sub'
  | 'blank_sub';

export type SiwcTokenStep =
  | { kind: 'error'; code: string }
  | { kind: 'http'; status: number; body?: string; headers?: Record<string, string> }
  | { kind: 'drop' }
  | { kind: 'lose_response' }
  | { kind: 'no_replacement_refresh_token' }
  | { kind: 'expires_in'; seconds: number }
  | { kind: 'hold'; reached: () => void; released: Promise<void> };

export type SiwcJwksStep = { kind: 'http'; status: number; body?: string } | { kind: 'drop' };

export type SiwcRevokeStep = { kind: 'http'; status: number; body?: string } | { kind: 'drop' } | { kind: 'hold'; reached: () => void; released: Promise<void> };

export type SiwcGrant = 'authorization_code' | 'refresh_token';

export type SiwcRecord = { method: string; path: string; form: Record<string, string> };

export type SiwcCalls = { authorize: number; tokenAuthorizationCode: number; tokenRefreshToken: number; revoke: number; jwks: number; discovery: number };

export type SiwcIdentity = { sub: string; email: string };

export type SiwcRegistration = { clientId: string; hostId: string; agentName: string; sub: string };

export type SiwcJwk = { kty: string; n: string; e: string; kid: string; alg: 'RS256'; use: 'sig' };

export type SiwcAuth = {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  jwksUrl: string;
  discoveryUrl: string;
  authorizeMode: SiwcAuthorizeMode;
  identity: SiwcIdentity;
  subjectOverride: string | undefined;
  idTokenFlaw: SiwcIdTokenFlaw | undefined;
  withheldScopes: string[];
  familyRevocationOnReuse: boolean;
  revokeSupersededFamily: boolean;
  records: SiwcRecord[];
  calls: SiwcCalls;
  scriptToken(grant: SiwcGrant, steps: SiwcTokenStep[]): void;
  scriptRevoke(steps: SiwcRevokeStep[]): void;
  scriptJwks(steps: SiwcJwksStep[]): void;
  rotateKeys(options: { retireOld: boolean }): Promise<string>;
  jwks(): { keys: SiwcJwk[] };
  disconnect(clientId: string): void;
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  verifyAccessToken(token: string | undefined, resource: string): 'valid' | 'expired' | 'revoked' | 'unknown';
  registrations(): SiwcRegistration[];
  issuedSecrets(): string[];
  close(): Promise<void>;
};

export type SiwcAccessTokenForm = 'jwt' | 'opaque';

export type SiwcAuthOptions = { now?: () => number; resource?: string; accessTokenForm?: SiwcAccessTokenForm };

type SigningKey = { kid: string; privateKey: KeyObject; jwk: SiwcJwk };

type Family = { clientId: string; revoked: boolean };

type AccessGrant = { family: Family; resource: string; expiresAtMs: number; expired: boolean };

type RefreshGrant = { family: Family; clientId: string; resource: string; scope: string; state: 'live' | 'consumed' | 'revoked'; expired: boolean };

type CodeGrant = { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string; nonce: string };

type Outcome = { status: number; body: unknown; headers?: Record<string, string> };

const generateKeyPairAsync = promisify(generateKeyPair);

const base64Url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const sha256Base64Url = (value: string): string => createHash('sha256').update(value).digest('base64url');

const newSigningKey = async (): Promise<SigningKey> => {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', { modulusLength: RSA_MODULUS_BITS });
  const kid = `kid-${randomBytes(6).toString('hex')}`;
  const exported = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return { kid, privateKey, jwk: { kty: exported.kty, n: exported.n, e: exported.e, kid, alg: 'RS256', use: 'sig' } };
};

let sharedKeys: Promise<{ signing: SigningKey; forged: SigningKey }> | undefined;

const sharedKeyPair = (): Promise<{ signing: SigningKey; forged: SigningKey }> => {
  sharedKeys ??= Promise.all([newSigningKey(), newSigningKey()]).then(([signing, forged]) => ({ signing, forged }));
  return sharedKeys;
};

const signRs256 = (header: Record<string, unknown>, claims: Record<string, unknown>, key: SigningKey, kid: string): string => {
  const signed = `${base64Url({ ...header, alg: 'RS256', typ: 'JWT', kid })}.${base64Url(claims)}`;
  const signature = createSign('RSA-SHA256').update(signed).sign(key.privateKey).toString('base64url');
  return `${signed}.${signature}`;
};

export const siwcBrowse = async (authorizeUrl: string): Promise<{ status: number; redirect?: URL; body?: unknown }> => {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location !== null) return { status: response.status, redirect: new URL(location) };
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
};

const isLoopbackCallback = (redirectUri: string): boolean => {
  const url = new URL(redirectUri);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === SIWC_CALLBACK_PATH;
};

export const startFakeSiwcAuth = async (options: SiwcAuthOptions = {}): Promise<SiwcAuth> => {
  const now = options.now ?? Date.now;
  const resource = options.resource ?? SIWC_RESOURCE;
  const accessTokenForm = options.accessTokenForm ?? 'jwt';
  const keys = await sharedKeyPair();
  const published: SigningKey[] = [keys.signing];
  let signing: SigningKey = keys.signing;
  const registrationsById = new Map<string, SiwcRegistration>();
  const codes = new Map<string, CodeGrant>();
  const usedCodes: string[] = [];
  const accessGrants = new Map<string, AccessGrant>();
  const refreshGrants = new Map<string, RefreshGrant>();
  const secrets: string[] = [];
  const tokenScripts: Record<SiwcGrant, SiwcTokenStep[]> = { authorization_code: [], refresh_token: [] };
  const revokeScript: SiwcRevokeStep[] = [];
  const jwksScript: SiwcJwksStep[] = [];
  const records: SiwcRecord[] = [];
  const calls: SiwcCalls = { authorize: 0, tokenAuthorizationCode: 0, tokenRefreshToken: 0, revoke: 0, jwks: 0, discovery: 0 };
  let earliestRefreshCounter = 0;
  let loopback: LoopbackServer | undefined;

  const fixture: SiwcAuth = {
    issuer: '',
    authorizeUrl: '',
    tokenUrl: '',
    revokeUrl: '',
    jwksUrl: '',
    discoveryUrl: '',
    authorizeMode: 'approve',
    identity: { sub: 'sub-fake-user', email: 'user@example.com' },
    subjectOverride: undefined,
    idTokenFlaw: undefined,
    withheldScopes: [],
    familyRevocationOnReuse: true,
    revokeSupersededFamily: false,
    records,
    calls,
    scriptToken: (grant, steps) => {
      tokenScripts[grant].push(...steps);
    },
    scriptRevoke: (steps) => {
      revokeScript.push(...steps);
    },
    scriptJwks: (steps) => {
      jwksScript.push(...steps);
    },
    rotateKeys: async ({ retireOld }) => {
      const fresh = await newSigningKey();
      if (retireOld) published.length = 0;
      published.push(fresh);
      signing = fresh;
      return fresh.kid;
    },
    jwks: () => ({ keys: published.map((key) => key.jwk) }),
    disconnect: (clientId) => {
      for (const grant of refreshGrants.values()) if (grant.clientId === clientId) grant.family.revoked = true;
    },
    expireAccessTokens: () => {
      for (const grant of accessGrants.values()) grant.expired = true;
    },
    expireRefreshTokens: () => {
      for (const grant of refreshGrants.values()) grant.expired = true;
    },
    verifyAccessToken: (token, resource) => {
      const grant = token === undefined ? undefined : accessGrants.get(token);
      if (grant === undefined || grant.resource !== resource) return 'unknown';
      if (grant.family.revoked) return 'revoked';
      return grant.expired || now() >= grant.expiresAtMs ? 'expired' : 'valid';
    },
    registrations: () => [...registrationsById.values()].map((registration) => ({ ...registration })),
    issuedSecrets: () => [...secrets],
    close: async () => {
      await loopback?.close();
    },
  };

  const remember = (secret: string): string => {
    secrets.push(secret);
    return secret;
  };

  const grantedScope = (requested: string): string =>
    requested
      .split(' ')
      .filter((scope) => scope !== '' && !fixture.withheldScopes.includes(scope))
      .join(' ');

  const idTokenFor = (clientId: string, grant: CodeGrant, scope: string): string => {
    const registration = registrationsById.get(clientId);
    const flaw = fixture.idTokenFlaw;
    const seconds = Math.floor(now() / 1000);
    const claims: Record<string, unknown> = {
      iss: flaw === 'wrong_issuer' ? 'https://attacker.invalid' : fixture.issuer,
      aud: flaw === 'wrong_audience' ? 'oaiapp_not_this_client' : clientId,
      sub: fixture.subjectOverride ?? registration?.sub ?? fixture.identity.sub,
      email: fixture.identity.email,
      nonce: flaw === 'wrong_nonce' ? 'not-the-nonce-of-the-attempt' : grant.nonce,
      scope,
      iat: seconds,
      exp: flaw === 'expired' ? seconds - ACCESS_TOKEN_SECONDS : seconds + ACCESS_TOKEN_SECONDS,
      jti: createCanary('idjti'),
    };
    if (flaw === 'missing_sub') delete claims['sub'];
    if (flaw === 'blank_sub') claims['sub'] = '';
    if (flaw === 'alg_none') return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url(claims)}.`;
    if (flaw === 'wrong_alg') {
      const signed = `${base64Url({ alg: 'HS256', typ: 'JWT', kid: signing.kid })}.${base64Url(claims)}`;
      return `${signed}.${createHmac('sha256', randomBytes(32)).update(signed).digest('base64url')}`;
    }
    if (flaw === 'forged_signature') return signRs256({}, claims, keys.forged, signing.kid);
    if (flaw === 'unknown_kid') return signRs256({}, claims, keys.forged, `kid-unknown-${randomBytes(4).toString('hex')}`);
    return signRs256({}, claims, signing, signing.kid);
  };

  const issueAccess = (family: Family, clientId: string, resource: string, scope: string, expiresIn: number): string => {
    const seconds = Math.floor(now() / 1000);
    const token = remember(
      accessTokenForm === 'opaque'
        ? randomBytes(32).toString('base64url')
        : signRs256(
            {},
            {
              sub: registrationsById.get(clientId)?.sub ?? fixture.identity.sub,
              aud: resource,
              client_id: clientId,
              scope,
              'https://api.openai.com/auth': { per_user_salt: createCanary('salt'), encrypted_auth_metadata: createCanary('meta') },
              iss: fixture.issuer,
              iat: seconds,
              exp: seconds + expiresIn,
              jti: createCanary('access'),
              nbf: seconds,
            },
            signing,
            signing.kid,
          ),
    );
    accessGrants.set(token, { family, resource, expiresAtMs: now() + expiresIn * 1000, expired: false });
    return token;
  };

  const issueRefresh = (family: Family, clientId: string, resource: string, scope: string): string => {
    const token = remember(createCanary('refresh'));
    refreshGrants.set(token, { family, clientId, resource, scope, state: 'live', expired: false });
    return token;
  };

  const tokenBody = (parts: { access: string; refresh?: string; idToken?: string; scope: string; expiresIn: number }): Record<string, unknown> => {
    earliestRefreshCounter += 1;
    return {
      access_token: parts.access,
      ...(parts.refresh === undefined ? {} : { refresh_token: parts.refresh }),
      ...(parts.idToken === undefined ? {} : { id_token: parts.idToken }),
      token_type: 'Bearer',
      expires_in: parts.expiresIn,
      scope: parts.scope,
      earliest_refresh_at: `opaque-${earliestRefreshCounter}-${randomBytes(4).toString('hex')}`,
    };
  };

  const oauthError = (code: string, status = 400): Outcome => ({ status, body: { error: code, error_description: code } });

  const exchangeCode = (form: Record<string, string>, step: SiwcTokenStep | undefined): Outcome => {
    const code = form['code'] ?? '';
    const grant = codes.get(code);
    codes.delete(code);
    if (grant === undefined) return oauthError('invalid_grant');
    usedCodes.push(code);
    if (
      grant.clientId !== form['client_id'] ||
      grant.redirectUri !== form['redirect_uri'] ||
      grant.challenge !== sha256Base64Url(form['code_verifier'] ?? '') ||
      grant.resource !== form['resource']
    ) {
      return oauthError('invalid_grant');
    }
    const expiresIn = step?.kind === 'expires_in' ? step.seconds : ACCESS_TOKEN_SECONDS;
    const family: Family = { clientId: grant.clientId, revoked: false };
    const body = tokenBody({
      access: issueAccess(family, grant.clientId, grant.resource, grant.scope, expiresIn),
      ...(step?.kind === 'no_replacement_refresh_token' ? {} : { refresh: issueRefresh(family, grant.clientId, grant.resource, grant.scope) }),
      idToken: remember(idTokenFor(grant.clientId, grant, grant.scope)),
      scope: grant.scope,
      expiresIn,
    });
    return { status: 200, body };
  };

  const rotateRefresh = (form: Record<string, string>, step: SiwcTokenStep | undefined): Outcome => {
    const presented = form['refresh_token'] ?? '';
    const grant = refreshGrants.get(presented);
    if (grant === undefined || grant.clientId !== form['client_id']) return oauthError('invalid_grant');
    if (grant.resource !== form['resource']) return oauthError('invalid_target');
    if (grant.family.revoked) return oauthError('refresh_token_invalidated');
    if (grant.state === 'consumed') {
      if (fixture.familyRevocationOnReuse) grant.family.revoked = true;
      return oauthError('refresh_token_reused');
    }
    if (grant.state === 'revoked') return oauthError('invalid_grant');
    if (grant.expired) return oauthError('refresh_token_expired');
    grant.state = 'consumed';
    const expiresIn = step?.kind === 'expires_in' ? step.seconds : ACCESS_TOKEN_SECONDS;
    const withoutReplacement = step?.kind === 'no_replacement_refresh_token';
    const body = tokenBody({
      access: issueAccess(grant.family, grant.clientId, grant.resource, grant.scope, expiresIn),
      ...(withoutReplacement ? {} : { refresh: issueRefresh(grant.family, grant.clientId, grant.resource, grant.scope) }),
      scope: grant.scope,
      expiresIn,
    });
    return { status: 200, body };
  };

  const write = (res: http.ServerResponse, outcome: Outcome): void => {
    sendJson(res, outcome.status, outcome.body, outcome.headers);
  };

  const handleToken = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)).entries());
    records.push({ method: 'POST', path: TOKEN_PATH, form });
    const grantType = form['grant_type'];
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      write(res, oauthError('unsupported_grant_type'));
      return;
    }
    if (grantType === 'authorization_code') calls.tokenAuthorizationCode += 1;
    else calls.tokenRefreshToken += 1;
    const step = tokenScripts[grantType].shift();
    if (step?.kind === 'hold') {
      step.reached();
      await step.released;
    }
    if (step?.kind === 'drop') {
      res.socket?.destroy();
      return;
    }
    if (step?.kind === 'error') {
      write(res, oauthError(step.code, step.code === 'invalid_client' ? 401 : 400));
      return;
    }
    if (step?.kind === 'http') {
      res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
      res.end(step.body ?? '{}');
      return;
    }
    const outcome = grantType === 'authorization_code' ? exchangeCode(form, step) : rotateRefresh(form, step);
    if (step?.kind === 'lose_response') {
      res.socket?.destroy();
      return;
    }
    write(res, outcome);
  };

  const handleRevoke = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)).entries());
    records.push({ method: 'POST', path: REVOKE_PATH, form });
    calls.revoke += 1;
    const step = revokeScript.shift();
    if (step?.kind === 'hold') {
      step.reached();
      await step.released;
    }
    if (step?.kind === 'drop') {
      res.socket?.destroy();
      return;
    }
    if (step?.kind === 'http') {
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(step.body ?? '');
      return;
    }
    const grant = refreshGrants.get(form['token'] ?? '');
    if (grant !== undefined && grant.clientId === form['client_id']) {
      if (grant.state === 'live') grant.state = 'revoked';
      else if (grant.state === 'consumed' && fixture.revokeSupersededFamily) grant.family.revoked = true;
    }
    res.writeHead(200, { 'content-length': '0' });
    res.end();
  };

  const handleAuthorize = (url: URL, res: http.ServerResponse): void => {
    const query = Object.fromEntries(url.searchParams.entries());
    records.push({ method: 'GET', path: AUTHORIZE_PATH, form: query });
    calls.authorize += 1;
    const refuse = (reason: string): void => sendJson(res, 400, { error: 'invalid_request', error_description: reason });
    const redirectUri = query['redirect_uri'] ?? '';
    if (redirectUri === '' || !isLoopbackCallback(redirectUri)) return refuse('redirect_uri must be http://127.0.0.1:<port>/auth/callback');
    if (query['response_type'] !== 'code') return refuse('response_type must be code');
    if (query['code_challenge_method'] !== 'S256' || (query['code_challenge'] ?? '') === '') return refuse('PKCE S256 is required');
    for (const name of ['state', 'nonce', 'ext_agent_host_id']) if ((query[name] ?? '') === '') return refuse(`${name} is required`);
    if (query['resource'] !== resource) return refuse('resource must be the Responses API');
    const hostId = query['ext_agent_host_id'] as string;
    const presented = query['client_id'] ?? '';
    const dynamic = presented === SIWC_DYNAMIC_CLIENT_ID;
    if (dynamic && (query['agent_name_hint'] ?? '') === '') return refuse('agent_name_hint is required for a registration');
    const known = registrationsById.get(presented);
    if (!dynamic && known === undefined) return refuse('unknown client_id');
    if (known !== undefined && (query['agent_name_hint'] !== undefined || known.hostId !== hostId)) return refuse('a returning sign-in omits agent_name_hint and keeps the host id');
    const target = new URL(redirectUri);
    const state = query['state'] as string;
    target.searchParams.set('state', fixture.authorizeMode === 'wrong_state' ? `${state}-tampered` : state);
    if (fixture.authorizeMode === 'access_denied') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'the user refused');
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    if (fixture.authorizeMode === 'replayed_code') {
      target.searchParams.set('code', usedCodes.at(-1) ?? createCanary('replayedcode'));
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    const clientId = known?.clientId ?? `oaiapp_${randomBytes(12).toString('hex')}`;
    if (known === undefined) {
      registrationsById.set(clientId, { clientId, hostId, agentName: query['agent_name_hint'] as string, sub: fixture.identity.sub });
    }
    const scope = grantedScope(query['scope'] ?? '');
    const code = remember(createCanary('code'));
    codes.set(code, { clientId, redirectUri, challenge: query['code_challenge'] as string, resource, scope, nonce: query['nonce'] as string });
    target.searchParams.set('code', code);
    target.searchParams.set('scope', scope);
    if (fixture.authorizeMode === 'foreign_client_id') target.searchParams.set('client_id', `oaiapp_${randomBytes(12).toString('hex')}`);
    else if (fixture.authorizeMode !== 'omit_client_id') target.searchParams.set('client_id', clientId);
    res.writeHead(302, { location: target.toString() });
    res.end();
  };

  loopback = await startLoopbackServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fixture.issuer);
    if (req.method === 'GET' && url.pathname === DISCOVERY_PATH) {
      calls.discovery += 1;
      records.push({ method: 'GET', path: DISCOVERY_PATH, form: {} });
      sendJson(res, 200, {
        issuer: fixture.issuer,
        authorization_endpoint: fixture.authorizeUrl,
        token_endpoint: fixture.tokenUrl,
        revocation_endpoint: fixture.revokeUrl,
        jwks_uri: fixture.jwksUrl,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === JWKS_PATH) {
      calls.jwks += 1;
      records.push({ method: 'GET', path: JWKS_PATH, form: {} });
      const jwksStep = jwksScript.shift();
      if (jwksStep?.kind === 'drop') {
        res.socket?.destroy();
        return;
      }
      if (jwksStep?.kind === 'http') {
        res.writeHead(jwksStep.status, { 'content-type': 'application/json' });
        res.end(jwksStep.body ?? '{}');
        return;
      }
      sendJson(res, 200, fixture.jwks());
      return;
    }
    if (req.method === 'GET' && url.pathname === AUTHORIZE_PATH) {
      handleAuthorize(url, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === TOKEN_PATH) {
      await handleToken(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === REVOKE_PATH) {
      await handleRevoke(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
  fixture.issuer = loopback.origin;
  fixture.authorizeUrl = `${loopback.origin}${AUTHORIZE_PATH}`;
  fixture.tokenUrl = `${loopback.origin}${TOKEN_PATH}`;
  fixture.revokeUrl = `${loopback.origin}${REVOKE_PATH}`;
  fixture.jwksUrl = `${loopback.origin}${JWKS_PATH}`;
  fixture.discoveryUrl = `${loopback.origin}${DISCOVERY_PATH}`;
  return fixture;
};
