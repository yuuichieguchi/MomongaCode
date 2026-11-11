import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_PROFILE_UNKNOWN_CODE, PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { StreamEvent } from '@momonga/protocol';
import { createRedactor } from '../src/core/redaction.ts';
import { createErrorExit } from '../src/server/error-exit.ts';
import { sseResponse } from '../src/server/sse.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { ACCOUNT, CALLBACK_PORT, accountRoute, startPlanGateway } from './plan-signin-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SOURCE = path.resolve(import.meta.dirname, '../src');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const filesWith = (roots: readonly string[], pattern: RegExp): string[] =>
  roots
    .flatMap((root) => (fs.statSync(path.join(SOURCE, root)).isDirectory() ? sourceFiles(path.join(SOURCE, root)) : [path.join(SOURCE, root)]))
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SOURCE, file))
    .sort();

describe('one definition per plan fact in the gateway (GR-onedef)', () => {
  it('OD-1: the lookup of a plan profile by its id is defined once', () => {
    expect(filesWith(['plan'], /ownEntry\(\w+(\.profiles)?, id\)/)).toEqual(['plan/profiles.ts']);
    expect(filesWith(['.'], /plan_profile_unknown/)).toEqual([]);
  });

  it('OD-2: the text of a thrown value is defined once for the plan files, the guarded adapter, the responder and the server', () => {
    expect(filesWith(['plan', 'server', 'core/guarded-adapter.ts', 'core/respond.ts', 'core/describe-error.ts'], /instanceof Error \? \w+\.message : String\(/)).toEqual(['core/describe-error.ts']);
  });

  it('OD-3: the internal-error answer is built in the one error exit', () => {
    expect(filesWith(['server', 'plan'], /'internal_error'/)).toEqual(['server/error-exit.ts']);
  });

  it('OD-4, OD-6: the plan files name each HTTP status once', () => {
    expect(filesWith(['plan'], /(_STATUS|_FLOOR|TOO_MANY_REQUESTS) = \d{3}\b/)).toEqual(['plan/http-status.ts']);
    expect(filesWith(['plan'], /status (===|!==|>=|<) \d{3}\b/)).toEqual([]);
  });

  it('OD-7: the answer for an account that is not found is defined once', () => {
    const api = fs.readFileSync(path.join(SOURCE, 'plan/api.ts'), 'utf8');
    expect(api.split('PLAN_ACCOUNT_NOT_FOUND_CODE').length - 1).toBe(2);
    expect(filesWith(['.'], /'plan_account_not_found'/)).toEqual([]);
  });
});

describe('the internal error answer of a stream carries no secret from its message (OD-3)', () => {
  it('an error that is not a GatewayError before the first event is answered through the redacted exit and reported once', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const secret = 'plan-access-token-0123456789abcdef';
    const reported: unknown[] = [];
    const exit = createErrorExit(createRedactor({ credentials: [secret] }), (error) => reported.push(error));
    const rest: AsyncIterator<StreamEvent> = {
      next: () => Promise.reject(new Error(`the upstream refused Bearer ${secret}`)),
      return: async () => ({ done: true, value: undefined }),
    };
    const response = sseResponse(undefined, rest, { timers, keepAliveMs: 1000, readerStallMs: 30_000, signal: new AbortController().signal, answer: exit.answer });
    const text = await response.text();
    expect(text).toContain('internal_error');
    expect(text).not.toContain(secret);
    expect(reported).toHaveLength(1);
    expect(String((reported[0] as Error).message)).not.toContain(secret);
  });
});

describe('plan_profile_unknown at its three sites', () => {
  it('begin, set-active, resume and the model list of an unknown profile answer 400 plan_profile_unknown naming the profile', async () => {
    const gateway = await startPlanGateway();
    registerCleanup(() => gateway.close());
    const expected = { status: 400, body: { error: { code: PLAN_PROFILE_UNKNOWN_CODE, param: 'profile', message: 'no plan profile is named "nowhere"' } } };
    expect(await gateway.post(PLAN_ROUTES.signInBegin, { profile: 'nowhere', account: ACCOUNT, port: CALLBACK_PORT })).toMatchObject(expected);
    expect(await gateway.post(PLAN_ROUTES.accountsActive, { profile: 'nowhere', account: ACCOUNT })).toMatchObject(expected);
    expect(await gateway.post(accountRoute(PLAN_ROUTES.accountResume), { profile: 'nowhere' })).toMatchObject(expected);
    expect(await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels)}?profile=nowhere`)).toMatchObject(expected);
  });
});
