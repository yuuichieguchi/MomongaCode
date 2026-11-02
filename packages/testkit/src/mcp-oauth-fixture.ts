import { createHash, randomBytes } from 'node:crypto';
import { readBody, sendJson, startLoopbackServer } from './loopback-http.ts';
import type { LoopbackServer } from './loopback-http.ts';

export type OauthFixtureRecord = { path: string; form: Record<string, string> };

export type AuthorizeMode = 'approve' | 'deny' | 'approve_without_iss' | 'approve_with_foreign_iss';

export type TokenVerdict = 'valid' | 'expired' | 'unknown';

export type McpOauthFixture = {
  issuer: string;
  records: OauthFixtureRecord[];
  authorizeMode: AuthorizeMode;
  verify(token: string | undefined, resource: string): TokenVerdict;
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  issuedAccessTokens(): string[];
  issuedRefreshTokens(): string[];
  close(): Promise<void>;
};

type CodeGrant = { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string };

type TokenGrant = { clientId: string; resource: string; scope: string; expired: boolean };

const sha256Base64Url = (value: string): string => createHash('sha256').update(value).digest('base64url');

const token = (prefix: string): string => `${prefix}-${randomBytes(12).toString('hex')}`;

export const startMcpOauthFixture = async (): Promise<McpOauthFixture> => {
  const records: OauthFixtureRecord[] = [];
  const codes = new Map<string, CodeGrant>();
  const accessTokens = new Map<string, TokenGrant>();
  const refreshTokens = new Map<string, TokenGrant>();
  const clients = new Set<string>();
  let clientCounter = 0;
  let loopback: LoopbackServer | undefined;

  const fixture: McpOauthFixture = {
    issuer: '',
    records,
    authorizeMode: 'approve',
    verify: (presented, resource) => {
      if (presented === undefined) return 'unknown';
      const grant = accessTokens.get(presented);
      if (grant === undefined || grant.resource !== resource) return 'unknown';
      return grant.expired ? 'expired' : 'valid';
    },
    expireAccessTokens: () => {
      for (const grant of accessTokens.values()) grant.expired = true;
    },
    revokeRefreshTokens: () => refreshTokens.clear(),
    issuedAccessTokens: () => [...accessTokens.keys()],
    issuedRefreshTokens: () => [...refreshTokens.keys()],
    close: async () => {
      await loopback?.close();
    },
  };

  const issue = (grant: Omit<TokenGrant, 'expired'>): Record<string, unknown> => {
    const access = token('at');
    const refresh = token('rt');
    accessTokens.set(access, { ...grant, expired: false });
    refreshTokens.set(refresh, { ...grant, expired: false });
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: grant.scope };
  };

  loopback = await startLoopbackServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fixture.issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, {
        issuer: fixture.issuer,
        authorization_endpoint: `${fixture.issuer}/authorize`,
        token_endpoint: `${fixture.issuer}/token`,
        registration_endpoint: `${fixture.issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      records.push({ path: '/register', form: { metadata: JSON.stringify(body) } });
      clientCounter += 1;
      const clientId = `client-${clientCounter}`;
      clients.add(clientId);
      sendJson(res, 201, { ...body, client_id: clientId });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const query = Object.fromEntries(url.searchParams.entries());
      records.push({ path: '/authorize', form: query });
      const redirectUri = query['redirect_uri'];
      const clientId = query['client_id'];
      if (redirectUri === undefined || clientId === undefined || !clients.has(clientId)) {
        sendJson(res, 400, { error: 'invalid_request' });
        return;
      }
      const target = new URL(redirectUri);
      const iss = fixture.authorizeMode === 'approve_with_foreign_iss' ? 'https://attacker.invalid' : fixture.issuer;
      if (fixture.authorizeMode !== 'approve_without_iss') target.searchParams.set('iss', iss);
      if (query['state'] !== undefined) target.searchParams.set('state', query['state']);
      if (fixture.authorizeMode === 'deny') {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'the user refused');
      } else {
        const code = token('code');
        codes.set(code, {
          clientId,
          redirectUri,
          challenge: query['code_challenge'] ?? '',
          resource: query['resource'] ?? '',
          scope: query['scope'] ?? '',
        });
        target.searchParams.set('code', code);
      }
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)).entries());
      records.push({ path: '/token', form });
      if (form['grant_type'] === 'authorization_code') {
        const grant = codes.get(form['code'] ?? '');
        codes.delete(form['code'] ?? '');
        const verifier = form['code_verifier'] ?? '';
        if (
          grant === undefined ||
          grant.clientId !== form['client_id'] ||
          grant.redirectUri !== form['redirect_uri'] ||
          grant.challenge !== sha256Base64Url(verifier) ||
          grant.resource !== form['resource']
        ) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        sendJson(res, 200, issue({ clientId: grant.clientId, resource: grant.resource, scope: grant.scope }));
        return;
      }
      if (form['grant_type'] === 'refresh_token') {
        const grant = refreshTokens.get(form['refresh_token'] ?? '');
        if (grant === undefined || grant.clientId !== form['client_id']) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        refreshTokens.delete(form['refresh_token'] ?? '');
        sendJson(res, 200, issue({ clientId: grant.clientId, resource: grant.resource, scope: grant.scope }));
        return;
      }
      sendJson(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
  fixture.issuer = loopback.origin;
  return fixture;
};
