import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { credentialFileFor, momongaLayout } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { planRouteError } from '../src/plan/api.ts';
import { PlanCredentialError } from '../src/plan/auth-source.ts';
import { GatewayError, statusFor } from '../src/core/errors.ts';
import { ACCOUNT, accountRoute, begin, browse, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { CONDITION_WAIT, PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SPARE = 'spare';

const recordFile = (gateway: PlanGateway, account: string): string => credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/${account}`);

const signInAs = async (gateway: PlanGateway, account: string): Promise<void> => {
  const begun = await begin(gateway, { account });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: account } });
};

const makeWorkActive = async (gateway: PlanGateway): Promise<void> => {
  expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
};

const labelsOf = (listed: { body: any }): string[] => (listed.body.accounts as { label: string }[]).map((entry) => entry.label).sort();

const problemNamesOf = (listed: { body: any }): string[] => ((listed.body.listProblems ?? []) as { file: string }[]).map((problem) => path.basename(problem.file)).sort();

const hold = (): { reached: Promise<void>; reach(): void; released: Promise<void>; release(): void } => {
  let reach = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, reach, released, release };
};

describe('the accounts the gateway lists are the record files of plan-sessions (O-R5-6 D)', () => {
  it('lists an untouched account after a restart when the records are in the plaintext form', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    await signInAs(gateway, ACCOUNT);
    await signInAs(gateway, SPARE);
    await makeWorkActive(gateway);
    expect(JSON.parse(fs.readFileSync(recordFile(gateway, SPARE), 'utf8'))).not.toHaveProperty('ciphertext');

    await gateway.restart();

    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.status).toBe(200);
    expect(labelsOf(listed)).toEqual([SPARE, ACCOUNT].sort());
    expect(listed.body.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ profile: PROFILE_ID, label: SPARE, state: 'active', pinnedBy: [] })]));
    expect(listed.body).not.toHaveProperty('listProblems');
    await gateway.close();
  });

  it('reports a record file copied under another hashed name as a list problem, not as an account', async () => {
    const gateway = await startPlanGateway();
    await signInAs(gateway, ACCOUNT);
    await signInAs(gateway, SPARE);
    await makeWorkActive(gateway);
    await gateway.close();
    const copy = credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/copied`);
    fs.copyFileSync(recordFile(gateway, SPARE), copy);
    fs.chmodSync(copy, 0o600);

    await gateway.restart();

    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.status).toBe(200);
    expect(labelsOf(listed)).toEqual([SPARE, ACCOUNT].sort());
    expect(problemNamesOf(listed)).toEqual([path.basename(copy)]);
    expect(listed.body.listProblems[0].cause).toEqual(expect.any(String));
    expect(listed.body.listProblems[0].cause.length).toBeGreaterThan(0);
    await gateway.close();
  });

  it('lists a record whose key reads but whose contents do not decrypt as store_unreadable with a cause, and an admin route answers 500 for it', async () => {
    const gateway = await startPlanGateway();
    await signInAs(gateway, ACCOUNT);
    await signInAs(gateway, SPARE);
    await makeWorkActive(gateway);
    await gateway.close();
    const file = recordFile(gateway, SPARE);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    const tag = envelope['tag'] as string;
    fs.writeFileSync(file, JSON.stringify({ ...envelope, tag: `${tag[0] === '0' ? '1' : '0'}${tag.slice(1)}` }), { mode: 0o600 });

    await gateway.restart();

    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.status).toBe(200);
    const spare = (listed.body.accounts as { label: string; state: string; cause?: string }[]).find((entry) => entry.label === SPARE);
    expect(spare?.state).toBe('store_unreadable');
    expect(spare?.cause).toEqual(expect.any(String));
    expect(spare?.cause?.length ?? 0).toBeGreaterThan(0);
    expect(listed.body).not.toHaveProperty('listProblems');

    const models = await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, SPARE)}?profile=${PROFILE_ID}`);
    expect(models.status).toBe(500);
    expect(models.body.error).toMatchObject({ type: 'server_error', code: 'plan_store_unreadable' });
    await gateway.close();
  });

  it('answers listProblems for a file it cannot read (a loose mode, not JSON) and keeps listing the others', async () => {
    const gateway = await startPlanGateway();
    await signInAs(gateway, ACCOUNT);
    await signInAs(gateway, SPARE);
    await makeWorkActive(gateway);
    await gateway.close();
    const loose = recordFile(gateway, SPARE);
    fs.chmodSync(loose, 0o644);
    const garbage = credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/garbage`);
    fs.writeFileSync(garbage, 'not json', { mode: 0o600 });
    fs.writeFileSync(path.join(sessionsDirectory(gateway.home), 'left.tmp'), 'partial', { mode: 0o600 });

    await gateway.restart();

    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.status).toBe(200);
    expect(labelsOf(listed)).toEqual([ACCOUNT]);
    expect(problemNamesOf(listed)).toEqual([path.basename(loose), path.basename(garbage)].sort());
    for (const problem of listed.body.listProblems as { cause: string }[]) expect(problem.cause.length).toBeGreaterThan(0);
    await gateway.close();
  });

  it('refuses begin after a restart when plan-host.json is missing and only an untouched record exists, and creates no host key (P5a)', async () => {
    const gateway = await startPlanGateway();
    await signInAs(gateway, SPARE);
    await gateway.close();
    const hostFile = momongaLayout(gateway.home).planHost;
    expect(fs.existsSync(hostFile)).toBe(true);
    fs.rmSync(hostFile);

    await gateway.restart();

    const begun = await begin(gateway, { account: 'third' });
    expect(begun.status).toBe(500);
    expect(begun.body.error.type).toBe('server_error');
    expect(begun.body.error.code).toBe('plan_host_identity_unavailable');
    expect(begun.body.error.message).toContain('plan-host.json');
    expect(begun.body.error.message).toContain('momonga auth reset-host');
    expect(fs.existsSync(hostFile)).toBe(false);
    await gateway.close();
  });
});

describe('the refusals answered by the routes themselves (O-R5-6 G 7 and 8)', () => {
  it('accounts/active of an account with no verified sign-in is 409 plan_account_not_selectable', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    await signInAs(gateway, SPARE);
    expect((await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);

    const moved = await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: SPARE });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toEqual({
      type: 'invalid_request',
      code: 'plan_account_not_selectable',
      message: `${SPARE} has no verified sign-in to switch to. Sign in to it first.`,
      param: null,
    });
    await gateway.close();
  });

  it('host/reset while a sign-in attempt is pending is 409 plan_sign_in_pending and keeps the host', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    const hostFile = momongaLayout(gateway.home).planHost;
    const hostBefore = fs.readFileSync(hostFile, 'utf8');
    expect((await begin(gateway, { account: SPARE })).status).toBe(200);

    const reset = await gateway.post(PLAN_ROUTES.hostReset, {});
    expect(reset.status).toBe(409);
    expect(reset.body.error).toEqual({
      type: 'invalid_request',
      code: 'plan_sign_in_pending',
      message: 'A sign-in is waiting for the browser. Finish or cancel it, then reset the host.',
      param: null,
    });
    expect(fs.readFileSync(hostFile, 'utf8')).toBe(hostBefore);
    await gateway.close();
  });

  it('begin for an account whose sign-out is still revoking is 409 plan_sign_out_in_progress', async () => {
    const gateway = await startPlanGateway();
    const revoke = hold();
    let signingOut: Promise<unknown> = Promise.resolve();
    try {
      expect((await signIn(gateway)).completed.status).toBe(200);
      gateway.auth.scriptRevoke([{ kind: 'hold', reached: revoke.reach, released: revoke.released }]);
      signingOut = gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT });
      await revoke.reached;
      const begun = await begin(gateway);
      expect(begun.status).toBe(409);
      expect(begun.body.error).toEqual({
        type: 'invalid_request',
        code: 'plan_sign_out_in_progress',
        message: `${ACCOUNT} is still signing out. Try again in a moment.`,
        param: null,
      });
    } finally {
      revoke.release();
      await signingOut;
      await gateway.close();
    }
  });
});

const markSigningOut = (gateway: PlanGateway, account: string): void => {
  const file = recordFile(gateway, account);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...record, state: 'signing_out' }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

const stateOf = async (gateway: PlanGateway, account: string): Promise<string | undefined> => {
  const listed = await gateway.get(PLAN_ROUTES.accounts);
  expect(listed.status).toBe(200);
  return (listed.body.accounts as { label: string; state: string }[]).find((entry) => entry.label === account)?.state;
};

describe('O-R5-6 L4: the load resumes an interrupted sign-out', () => {
  it('a signing_out record found on disk is resumed when the accounts route loads it', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    await signInAs(gateway, ACCOUNT);
    await signInAs(gateway, SPARE);
    await gateway.close();
    markSigningOut(gateway, SPARE);
    await gateway.restart();
    expect(gateway.auth.calls.revoke).toBe(0);
    expect((await gateway.get(PLAN_ROUTES.accounts)).status).toBe(200);
    await vi.waitFor(() => expect(gateway.auth.calls.revoke).toBe(1), CONDITION_WAIT);
    await vi.waitFor(async () => expect(await stateOf(gateway, SPARE)).toBe('registered'), CONDITION_WAIT);
    expect(gateway.auth.calls.revoke).toBe(1);
    await gateway.close();
  });

  it('begin on it answers 409 plan_sign_out_in_progress until the resumed sign-out ends, then succeeds', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    const revoke = hold();
    try {
      await signInAs(gateway, ACCOUNT);
      await signInAs(gateway, SPARE);
      await gateway.close();
      markSigningOut(gateway, SPARE);
      gateway.auth.scriptRevoke([{ kind: 'hold', reached: revoke.reach, released: revoke.released }]);
      await gateway.restart();
      const refused = await begin(gateway, { account: SPARE });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toEqual({
        type: 'invalid_request',
        code: 'plan_sign_out_in_progress',
        message: `${SPARE} is still signing out. Try again in a moment.`,
        param: null,
      });
      await vi.waitFor(() => expect(gateway.auth.calls.revoke).toBe(1), CONDITION_WAIT);
      expect((await begin(gateway, { account: SPARE })).status).toBe(409);
      revoke.release();
      await vi.waitFor(async () => expect(await stateOf(gateway, SPARE)).toBe('registered'), CONDITION_WAIT);
      expect(gateway.auth.calls.revoke).toBe(1);
      expect((await begin(gateway, { account: SPARE })).status).toBe(200);
    } finally {
      revoke.release();
      await gateway.close();
    }
  });
});

describe('admin routes translate a PlanCredentialError by the one status rule of M7 (O-R5-6 G 9)', () => {
  const translatedOf = (code: string, retryable: boolean): GatewayError => {
    const translated = planRouteError(new PlanCredentialError(code, `message of ${code}`, retryable));
    expect(translated).toBeInstanceOf(GatewayError);
    return translated as GatewayError;
  };

  it.each([
    ['sign_in_required', 401],
    ['plan_use_not_enabled', 403],
    ['plan_usage_paused', 429],
    ['plan_store_unreadable', 500],
    ['plan_store_unwritable', 500],
    ['plan_host_identity_unavailable', 500],
  ] as const)('%s answers %i', (code, status) => {
    const translated = translatedOf(code, false);
    expect(translated.status).toBe(status);
    expect(translated.body.code).toBe(code);
    expect(translated.body.message).toBe(`message of ${code}`);
  });

  it('the store codes and plan_host_identity_unavailable are server_error and the paused code too_many_requests (N-chatgpt-r5, O-R5-6 J 1)', () => {
    expect(translatedOf('plan_store_unreadable', false).body.type).toBe('server_error');
    expect(translatedOf('plan_host_identity_unavailable', false).body.type).toBe('server_error');
    expect(translatedOf('plan_store_unwritable', false).body.type).toBe('server_error');
    expect(translatedOf('plan_usage_paused', false).body.type).toBe('too_many_requests');
  });

  it('plan_host_identity_unavailable is 500 through the one status mapping, as the store codes are (O-R5-6 J 1)', () => {
    expect(statusFor('server_error', 'plan_host_identity_unavailable')).toBe(500);
    expect(statusFor('server_error', 'plan_store_unreadable')).toBe(500);
  });

  it('the retryable plan_credential_unavailable keeps 503 server_error', () => {
    const translated = translatedOf('plan_credential_unavailable', true);
    expect(translated.status).toBe(503);
    expect(translated.body.type).toBe('server_error');
  });
});

describe('O-R5-6 (M) 8.2: the active pointer has one reader of its file, the open', () => {
  it('the active pointer is read from the file once at open and every later reader uses the mirror', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    try {
      const activeFile = momongaLayout(gateway.home).planActive;
      const activeOf = async (): Promise<Record<string, boolean>> => {
        const listed = await gateway.get(PLAN_ROUTES.accounts);
        expect(listed.status).toBe(200);
        return Object.fromEntries((listed.body.accounts as { label: string; active: boolean }[]).map((entry) => [entry.label, entry.active]));
      };
      await signInAs(gateway, ACCOUNT);
      await signInAs(gateway, SPARE);
      await makeWorkActive(gateway);
      fs.rmSync(activeFile);

      expect(await activeOf()).toMatchObject({ [ACCOUNT]: true, [SPARE]: false });

      await gateway.restart();
      expect(Object.values(await activeOf())).not.toContain(true);

      expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);
      expect(fs.existsSync(activeFile)).toBe(true);
      await gateway.restart();
      expect(await activeOf()).toMatchObject({ [SPARE]: true });
    } finally {
      await gateway.close();
    }
  });
});
