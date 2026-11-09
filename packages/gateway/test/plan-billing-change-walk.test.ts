import { describe, expect, it } from 'vitest';
import type { CapabilityOverride, TargetBilling } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import type { ScriptedAdapter } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import type { ConfigOverrides } from './gateway-helpers.ts';

type Member = { name: string; billing: TargetBilling; fails?: boolean; capabilities?: CapabilityOverride };

const adapterOf = (member: Member): ScriptedAdapter =>
  createScriptedAdapter({
    ...(member.capabilities === undefined ? {} : { capabilities: member.capabilities }),
    calls: [
      member.fails === true
        ? { failure: { status: 503, message: `${member.name} is unavailable` } }
        : { events: textResponseEvents({ model: `model-${member.name}`, chunks: ['served'], usage: usageOf(5, 1) }) },
    ],
  });

const startAlias = async (members: readonly Member[], billingChanges?: ConfigOverrides['billingChanges'], aliases?: Record<string, string[]>) => {
  const adapters = Object.fromEntries(members.map((member) => [member.name, adapterOf(member)]));
  const harness = await startGateway({
    adapters,
    config: {
      aliases: aliases ?? { fast: members.map((member) => member.name) },
      targets: Object.fromEntries(members.map((member) => [member.name, { model: `model-${member.name}`, billing: member.billing }])),
      retry: { maxAttempts: 1, totalWaitMs: 1 },
      ...(billingChanges === undefined ? {} : { billingChanges }),
    },
  });
  const post = async (body: Record<string, unknown> = {}) => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), ...body }));
  return { adapters: adapters as Record<string, ScriptedAdapter>, post };
};

const PLAN_FAILING: Member = { name: 'plan', billing: 'plan', fails: true };
const METERED: Member = { name: 'metered', billing: 'metered' };

describe('a fallback that changes the billing kind needs the user policy (M9, I-B2)', () => {
  it('ends the request with the first member cause and never tries a metered member after a plan member under the empty policy', async () => {
    const alias = await startAlias([PLAN_FAILING, METERED]);
    const response = await alias.post();
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('upstream_error');
    expect(alias.adapters['metered']?.calls).toHaveLength(0);
    expect(response.body.error.message.endsWith(' Model target "metered" was not tried: changing from plan to metered billing is not allowed (models.billingChanges).')).toBe(true);
  });

  it('records the refused hop as a fallback cause of its own when a later member of the current kind answers', async () => {
    const alias = await startAlias([PLAN_FAILING, METERED, { name: 'plan-second', billing: 'plan' }]);
    const response = await alias.post();
    expect(response.status).toBe(200);
    expect(response.body.momonga.fallbackCauses).toContainEqual(
      expect.objectContaining({ target: 'metered', code: 'billing_change_refused', reason: 'billing_change_refused', fromBilling: 'plan', toBilling: 'metered' }),
    );
  });

  it('moves to the metered member when the policy holds plan to metered, recording both kinds and the reason', async () => {
    const alias = await startAlias([PLAN_FAILING, METERED], [{ from: 'plan', to: 'metered' }]);
    const response = await alias.post();
    expect(response.status).toBe(200);
    expect(alias.adapters['metered']?.calls).toHaveLength(1);
    expect(response.body.momonga.fallbackCauses).toMatchObject([
      { target: 'plan', code: 'upstream_error', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_allowed' },
    ]);
  });

  it('does not apply a pair scoped to another alias', async () => {
    const alias = await startAlias([PLAN_FAILING, METERED], [{ from: 'plan', to: 'metered', alias: 'other' }], { fast: ['plan', 'metered'], other: ['metered'] });
    const response = await alias.post();
    expect(response.status).toBe(502);
    expect(alias.adapters['metered']?.calls).toHaveLength(0);
  });

  it('passes over a member of another kind and goes on to a later member of the current kind, recording the refusal', async () => {
    const alias = await startAlias([PLAN_FAILING, METERED, { name: 'plan-second', billing: 'plan' }]);
    const response = await alias.post();
    expect(response.status).toBe(200);
    expect(alias.adapters['metered']?.calls).toHaveLength(0);
    expect(alias.adapters['plan-second']?.calls).toHaveLength(1);
    expect(response.body.momonga.fallbackCauses).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_refused' })]),
    );
  });

  it('applies the same rule when the first member leaves by a narrowing refusal', async () => {
    const alias = await startAlias([{ name: 'plan', billing: 'plan', capabilities: { sampling: { accepts: 'none' } } }, { ...METERED, capabilities: { sampling: { accepts: 'free' } } }]);
    const response = await alias.post({ temperature: 0.2 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('sampling_not_accepted');
    expect(alias.adapters['plan']?.calls).toHaveLength(0);
    expect(alias.adapters['metered']?.calls).toHaveLength(0);
  });

  it('judges a free-to-metered change by the same data rule as plan-to-metered', async () => {
    const refused = await startAlias([{ name: 'local', billing: 'local', fails: true }, METERED]);
    expect((await refused.post()).status).toBe(502);
    expect(refused.adapters['metered']?.calls).toHaveLength(0);

    const allowed = await startAlias([{ name: 'local', billing: 'local', fails: true }, METERED], [{ from: 'local', to: 'metered' }]);
    const response = await allowed.post();
    expect(response.status).toBe(200);
    expect(response.body.momonga.fallbackCauses).toMatchObject([{ target: 'local', fromBilling: 'local', toBilling: 'metered', reason: 'billing_change_allowed' }]);
  });

  it('judges the next hop from the last member sent a request, so a member passed over by its breaker does not change the kind', async () => {
    const adapters = {
      plan: adapterOf(PLAN_FAILING),
      local: adapterOf({ name: 'local', billing: 'local', fails: true }),
      metered: adapterOf(METERED),
    };
    const harness = await startGateway({
      adapters,
      config: {
        aliases: { warm: ['local'], fast: ['plan', 'local', 'metered'] },
        targets: { plan: { model: 'model-plan', billing: 'plan' }, local: { model: 'model-local', billing: 'local' }, metered: { model: 'model-metered', billing: 'metered' } },
        retry: { maxAttempts: 1, totalWaitMs: 1 },
        breaker: { failureThreshold: 1 },
        billingChanges: [
          { from: 'plan', to: 'local' },
          { from: 'local', to: 'metered' },
        ],
      },
    });
    expect((await readJson(await postJson(harness.client, '/v1/responses', { model: 'warm', input: userInput('hi') }))).status).toBe(502);
    const response = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(502);
    expect(adapters.local.calls).toHaveLength(1);
    expect(adapters.metered.calls).toHaveLength(0);
    expect(response.body.error.message.endsWith(' Model target "metered" was not tried: changing from plan to metered billing is not allowed (models.billingChanges).')).toBe(true);
  });
});
