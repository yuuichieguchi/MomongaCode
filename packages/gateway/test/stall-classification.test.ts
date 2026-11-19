import { describe, expect, it } from 'vitest';
import { planProfileOf } from '@momonga/config';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';
import { UPSTREAM_IDLE_CODE, upstreamIdleText } from '../src/adapters/shared/content-idle.ts';
import { UpstreamStall } from '../src/adapters/shared/failures.ts';

describe('an upstream idle stop', () => {
  it.each([
    ['no rules', createUpstreamClassifier('fake')],
    ['the plan route rules', createUpstreamClassifier('plan route', planProfileOf('chatgpt').errorRules)],
  ])('is classified as a stall with %s, so the gateway hands it to the run instead of retrying it', (_label, classify) => {
    const classified = classify(new UpstreamStall(UPSTREAM_IDLE_CODE, upstreamIdleText(300)));
    expect(classified).toMatchObject({ retryable: true, stalled: true, error: { code: UPSTREAM_IDLE_CODE, message: upstreamIdleText(300) } });
  });
});
