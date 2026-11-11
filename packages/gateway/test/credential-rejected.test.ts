import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGN_IN_COMMAND } from '@momonga/protocol';
import type { ClassifiedError } from '@momonga/protocol';
import { planProfileOf } from '@momonga/config';
import { applyCredentialEffect } from '../src/adapters/shared/auth.ts';
import { PROFILE_ID, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const rejectedAfterForcedRefresh: ClassifiedError = {
  retryable: false,
  credential: 'rejected',
  error: { type: 'invalid_request', code: 'plan_credential_rejected', message: 'refused', param: null },
};

const DEVELOPER_PHRASES = ['POST /v1', 'route', 'grant', 'API-key', 'target', 'only after a confirmed revocation'];

const rules = planProfileOf('chatgpt').errorRules;

describe('a credential the provider rejects after a forced refresh', () => {
  it('marks the account sign-in expired and its health not ok', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    await source.read(new AbortController().signal);
    expect(source.health().ok).toBe(true);

    await applyCredentialEffect(source, rejectedAfterForcedRefresh, h.clock, new AbortController().signal);

    expect(source.status().state).toBe('needs_sign_in');
    const health = source.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain(planProfileOf('chatgpt').messages.signInExpiredMessage);
  });

  it('the rule text of a rejected credential names the sign-in command', () => {
    const rejecting = rules.filter((rule) => rule.credential === 'rejected');
    expect(rejecting.length).toBeGreaterThan(0);
    for (const rule of rejecting) expect(rule.message).toContain(SIGN_IN_COMMAND);
  });

  it('every rule message is a sentence for the person; developer notes are kept in the cause', () => {
    const shown = rules.flatMap((rule) => DEVELOPER_PHRASES.filter((phrase) => rule.message.includes(phrase)).map((phrase) => `${rule.code}: ${phrase}`));
    expect(shown).toEqual([]);
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../config/src/plan-profiles.ts'), 'utf8');
    expect(source).toContain("cause: 'The route is POST /v1/responses'");
  });
});
