import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_WAIT_MS } from '@momonga/foundation';
import { PLAN_ACCOUNT_STATES } from '@momonga/protocol';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS } from '../src/defaults.ts';
import { PLAN_CONFIGURATION_REFRESH_CODES, PLAN_TERMINAL_REFRESH_CODES } from '../src/plan/refresh.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const constants = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'protocol', 'src', 'plan-constants.json'), 'utf8')) as {
  credentialStates: string[];
  terminalCodes: string[];
  configurationCodes: string[];
  causes: string[];
};
const planSource = path.join(root, 'packages', 'gateway', 'src', 'plan');
const authorizeSource = fs.readFileSync(path.join(root, 'packages', 'mcp', 'src', 'authorize.ts'), 'utf8');

describe('the session engine against plan-constants.json, the JSON PlanCredential.tla and PlanSignIn.tla read', () => {
  it('classifies exactly the terminal codes of the constants as terminal (NoEraseOnTransient)', () => {
    expect([...PLAN_TERMINAL_REFRESH_CODES].sort()).toEqual([...constants.terminalCodes].sort());
  });

  it('classifies exactly the configuration codes of the constants as configuration', () => {
    expect([...PLAN_CONFIGURATION_REFRESH_CODES].sort()).toEqual([...constants.configurationCodes].sort());
  });

  it('uses the account states of the constants', () => {
    expect([...PLAN_ACCOUNT_STATES].sort()).toEqual([...constants.credentialStates].sort());
  });
});

describe('PLAN_SESSION_DEFAULTS: the numbers of design section 6 that P5a uses, and only those', () => {
  const retry = GATEWAY_CONFIG_DEFAULTS.retry;

  it('states exactly P5a numbers', () => {
    expect(PLAN_SESSION_DEFAULTS).toEqual({
      accessLifetimeMs: 3_600_000,
      attemptTimeoutMs: 15_000,
      revocationTimeoutMs: 10_000,
      skewMs: 60_000,
      refreshBudgetMs: 61_000,
      marginMs: 121_000,
      revocationBudgetMs: 31_500,
      persistRetryMs: 30_000,
      persistRetryMaxMs: 900_000,
      replacedAccessTokensKept: 3,
    });
  });

  it('derives B from the retry policy: attempts x T_a + (attempts - 1) x retry.maxMs', () => {
    expect(PLAN_SESSION_DEFAULTS.refreshBudgetMs).toBe(retry.maxAttempts * PLAN_SESSION_DEFAULTS.attemptTimeoutMs + (retry.maxAttempts - 1) * retry.maxMs);
  });

  it('derives M = S + B', () => {
    expect(PLAN_SESSION_DEFAULTS.marginMs).toBe(PLAN_SESSION_DEFAULTS.skewMs + PLAN_SESSION_DEFAULTS.refreshBudgetMs);
  });

  it('derives the revocation budget = attempts x T_rev + 500 + 1000', () => {
    expect(PLAN_SESSION_DEFAULTS.revocationBudgetMs).toBe(retry.maxAttempts * PLAN_SESSION_DEFAULTS.revocationTimeoutMs + retry.baseMs + 2 * retry.baseMs);
  });

  it('takes the persist retry from breaker.openMs', () => {
    expect(PLAN_SESSION_DEFAULTS.persistRetryMs).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.openMs);
  });
});

describe('AUTHORIZATION_WAIT_MS has one source, in foundation', () => {
  it('is 300 s and exported by foundation', () => {
    expect(AUTHORIZATION_WAIT_MS).toBe(300_000);
  });

  it('mcp/src/authorize.ts imports it and declares no constant of its own', () => {
    expect(authorizeSource).not.toMatch(/const AUTHORIZATION_WAIT_MS\s*=/);
    expect(authorizeSource).toMatch(/import \{[^}]*\bAUTHORIZATION_WAIT_MS\b[^}]*\} from '@momonga\/foundation'/);
  });
});

describe('M8: no synchronous call under gateway/src/plan', () => {
  const files = ['session.ts', 'host-identity.ts', 'active-account.ts', 'refresh.ts', 'revoke.ts', 'auth-source.ts'];

  it('has the files of the design', () => {
    for (const file of files) expect(fs.existsSync(path.join(planSource, file)), file).toBe(true);
  });

  it('contains no *Sync( call in any source file', () => {
    const sources = fs.readdirSync(planSource).filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThanOrEqual(files.length);
    for (const name of sources) expect(fs.readFileSync(path.join(planSource, name), 'utf8'), name).not.toMatch(/[A-Za-z]Sync\s*\(/);
  });
});
