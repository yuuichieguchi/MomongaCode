import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import type { SiwcEarliestRefreshAtForm } from '@momonga/testkit';
import { accountRoute, recordingLogger, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { RecordedEvent } from './plan-signin-support.ts';
import { PLAN_ROUTES } from '@momonga/protocol';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LISTED = [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: 200000 }];

const KEPT: Readonly<Record<SiwcEarliestRefreshAtForm, RegExp | undefined>> = {
  number: /^\d+$/,
  string: /^opaque-\d+-[0-9a-f]{8}$/,
  null: undefined,
  absent: undefined,
};

const FORMS = Object.keys(KEPT) as SiwcEarliestRefreshAtForm[];

const expectKept = (value: unknown, form: SiwcEarliestRefreshAtForm): void => {
  const pattern = KEPT[form];
  if (pattern === undefined) expect(value).toBeUndefined();
  else expect(value).toMatch(pattern);
};

describe('earliest_refresh_at never refuses a token response: a string or a number is kept raw, any other shape is absent (sign-in 10.4 step 6)', () => {
  it.each(FORMS)('a sign-in and a refresh whose issuer sends earliest_refresh_at as %s both succeed', async (form) => {
    const events: RecordedEvent[] = [];
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ clock, models: LISTED, earliestRefreshAtForm: form, logger: recordingLogger(events) });
    const { completed } = await signIn(gateway);
    expect(completed.status).toBe(200);
    expect(completed.body?.outcome).toBe('signed_in');
    const signedIn = events.find((event) => event.name === 'plan.sign_in' && event.data['outcome'] === 'signed_in');
    expectKept(signedIn?.data['earliestRefreshAt'], form);
    const route = `${accountRoute(PLAN_ROUTES.accountModels)}?profile=${PROFILE_ID}&refresh=1`;
    expect((await gateway.get(route)).status).toBe(200);
    clock.advance(86_400_000);
    expect((await gateway.get(route)).status).toBe(200);
    const refreshed = events.find((event) => event.name === 'plan.refresh');
    expect(refreshed?.data['outcome']).toBe('adopted');
    expectKept(refreshed?.data['earliestRefreshAt'], form);
    await gateway.close();
  });
});
