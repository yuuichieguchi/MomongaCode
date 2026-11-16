import { describe, expect, it } from 'vitest';
import { refusalOf } from './load-models.ts';
import { S3_PLAN } from './model-fixtures.ts';

const withProfile = (profile: string) => ({ models: { connections: [{ ...S3_PLAN, plan: { profile } }] } });

describe('the profile name of a plan reference', () => {
  it('is refused at load by the schema when it is outside the account label pattern', async () => {
    const { message } = await refusalOf(withProfile('chatgpt '));
    expect(message).toMatch(/invalid settings at \/models\/connections\/0\/plan\/profile/);
  });
});
