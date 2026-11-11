import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ModelsEditRefused } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { PLAN_HOST_IDENTITY_UNAVAILABLE_CODE, PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { GatewayError } from '../src/core/errors.ts';
import { planRouteError } from '../src/plan/api.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { writeSettings } from './gateway-process-helpers.ts';
import { accountRoute, signIn, startPlanGateway } from './plan-signin-support.ts';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LISTED = [{ slug: 'plan-extra', display_name: 'Plan Extra', visibility: 'list', context_window: 200000 }];

describe('every plan route error passes one mapping (P-162, N-G5-1, G5-4)', () => {
  it('a refused settings edit maps to the refusal\'s own code and message: a conflict for a name or a file that stands in the way, an invalid request for a value', () => {
    const taken = planRouteError(new ModelsEditRefused('name_taken', 'Not saved: the name gpt is taken.'));
    expect(taken).toBeInstanceOf(GatewayError);
    expect(taken).toMatchObject({ status: 409, body: { type: 'invalid_request', code: 'name_taken', message: 'Not saved: the name gpt is taken.' } });
    expect(planRouteError(new ModelsEditRefused('duplicate', 'Not saved: duplicate.'))).toMatchObject({ status: 409, body: { code: 'duplicate' } });
    expect(planRouteError(new ModelsEditRefused('would_not_load', 'Not saved: it would not load.'))).toMatchObject({ status: 409, body: { code: 'would_not_load' } });
    expect(planRouteError(new ModelsEditRefused('invalid_value', 'Not saved: bad value.'))).toMatchObject({ status: 400, body: { code: 'invalid_value' } });
    expect(planRouteError(new ModelsEditRefused('reserved_name', 'Not saved: reserved.'))).toMatchObject({ status: 400, body: { code: 'reserved_name' } });
    expect(planRouteError(new ModelsEditRefused('unresolved', 'Not saved: unresolved.'))).toMatchObject({ status: 400, body: { code: 'unresolved' } });
  });

  it('an error of no known class is left as it is for the one redacted exit', () => {
    const unknown = new Error('something else');
    expect(planRouteError(unknown)).toBe(unknown);
  });

  it('addTarget on a settings file the writer refuses answers the refusal\'s message and status, not an internal error', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    registerCleanup(() => gateway.close());
    await signIn(gateway);
    const listed = await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels)}?profile=${PROFILE_ID}&refresh=1`);
    expect(listed.status).toBe(200);
    writeSettings(gateway.home, { models: { fallback: 'not a list' } });
    const answer = await gateway.post(accountRoute(PLAN_ROUTES.accountTargets), { profile: PROFILE_ID, slug: 'plan-extra' });
    expect(answer.body.error.code).not.toBe('internal_error');
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatchObject({ type: 'invalid_request', code: 'invalid_value' });
    expect(answer.body.error.message).toBe('invalid settings at /models/fallback: must be array');
  });

  it('host/reset whose identity file cannot be written answers 500 plan_host_identity_unavailable, as begin does', async () => {
    const gateway = await startPlanGateway();
    registerCleanup(() => gateway.close());
    const directory = path.dirname(momongaLayout(gateway.home, process.platform, process.env).planHost);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const hostFile = momongaLayout(gateway.home, process.platform, process.env).planHost;
    fs.mkdirSync(hostFile, { recursive: true });
    registerCleanup(() => fs.rmSync(hostFile, { recursive: true, force: true }));
    const answer = await gateway.post(PLAN_ROUTES.hostReset, {});
    expect(answer.status).toBe(500);
    expect(answer.body.error.code).toBe(PLAN_HOST_IDENTITY_UNAVAILABLE_CODE);
  });
});
