import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SECRET_NAME_PATTERN } from '@momonga/foundation';
import { PLAN_LABEL_PATTERN, PLAN_LABEL_REFUSAL, PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ACCOUNT, accountRoute, begin, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BAD_LABEL = 'team/work';
const LONG_NON_ASCII_LABEL = 'ラベル'.repeat(60);

const LABEL_ERROR = { type: 'invalid_request', code: 'invalid_account_label', message: PLAN_LABEL_REFUSAL, param: 'account' };

type Answer = { status: number; body: any };

const ROUTES: ReadonlyArray<{ name: string; call(gateway: PlanGateway, label: string): Promise<Answer> }> = [
  { name: 'accounts/active', call: (gateway, label) => gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: label }) },
  { name: 'accounts/:account/resume', call: (gateway, label) => gateway.post(accountRoute(PLAN_ROUTES.accountResume, label), { profile: PROFILE_ID }) },
  { name: 'accounts/:account/models', call: (gateway, label) => gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, label)}?profile=${PROFILE_ID}`) },
  { name: 'accounts/:account/targets', call: (gateway, label) => gateway.post(accountRoute(PLAN_ROUTES.accountTargets, label), { profile: PROFILE_ID }) },
  { name: 'sign-out', call: (gateway, label) => gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: label }) },
];

describe('every route checks the account label before it reaches the sessions (P-G-label)', () => {
  it('each of accounts/active, sign-out, accounts/:account/resume, models and targets answers 400 invalid_account_label for a label with a slash, and a following GET accounts lists no new entry', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    const before = (await gateway.get(PLAN_ROUTES.accounts)).body.accounts.map((entry: { label: string }) => entry.label).sort();
    for (const route of ROUTES) {
      const answer = await route.call(gateway, BAD_LABEL);
      expect({ route: route.name, status: answer.status, error: answer.body?.error }).toEqual({ route: route.name, status: 400, error: LABEL_ERROR });
    }
    const after = (await gateway.get(PLAN_ROUTES.accounts)).body.accounts.map((entry: { label: string }) => entry.label).sort();
    expect(after).toEqual(before);
    await gateway.close();
  });

  it('each route answers the same refusal for an over-long label outside ASCII', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    for (const route of [...ROUTES, { name: 'sign-in/begin', call: (started: PlanGateway, label: string) => begin(started, { account: label }) }]) {
      const answer = await route.call(gateway, LONG_NON_ASCII_LABEL);
      expect({ route: route.name, status: answer.status, error: answer.body?.error }).toEqual({ route: route.name, status: 400, error: LABEL_ERROR });
    }
    await gateway.close();
  });

  it('sign-in/begin keeps answering 400 invalid_account_label with the same text', async () => {
    const gateway = await startPlanGateway();
    const answer = await begin(gateway, { account: BAD_LABEL });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toEqual(LABEL_ERROR);
    await gateway.close();
  });

  it('a valid label still passes on every route', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    for (const route of ROUTES) {
      const answer = await route.call(gateway, ACCOUNT);
      expect({ route: route.name, code: answer.body?.error?.code }).not.toEqual({ route: route.name, code: 'invalid_account_label' });
    }
    await gateway.close();
  });
});

describe('the label rule has one definition, in protocol (A2)', () => {
  it('the one refusal text names the pattern, and the pattern is the one of secret names', () => {
    expect(PLAN_LABEL_REFUSAL).toBe(`the account label must match ${PLAN_LABEL_PATTERN}`);
    expect(PLAN_LABEL_PATTERN).toBe(SECRET_NAME_PATTERN);
  });

  it('no written package source outside protocol defines a label rule of its own (a generated bundle carries the one of protocol)', () => {
    const packages = path.resolve(import.meta.dirname, '..', '..');
    const sources = fs
      .readdirSync(packages)
      .filter((name) => name !== 'protocol' && fs.existsSync(path.join(packages, name, 'src')))
      .flatMap((name) => fs.readdirSync(path.join(packages, name, 'src'), { recursive: true, encoding: 'utf8' }).map((file) => path.join(packages, name, 'src', file)))
      .filter((file) => /\.tsx?$/.test(file) && !/\.generated\.ts$/.test(file));
    const own = sources.filter((file) => /(?:const|function)\s+(?:PLAN_LABEL_PATTERN|isPlanLabel)\b|label must match/.test(fs.readFileSync(file, 'utf8')));
    expect(own.map((file) => path.relative(packages, file))).toEqual([]);
    expect(fs.existsSync(path.join(packages, 'gateway', 'src', 'plan', 'label.ts'))).toBe(false);
  });
});
