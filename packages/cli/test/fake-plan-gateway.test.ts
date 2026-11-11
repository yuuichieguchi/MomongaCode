import { describe, expect, it } from 'vitest';
import { fakePlanBackend } from './fake-plan-gateway.tsx';

describe('the fake plan gateway lists its models from one source', () => {
  it('a listing is the listing of its backend: it is recorded, and it holds a model added through a plan account', async () => {
    const backend = fakePlanBackend();
    const { model } = await backend.plan.addTarget('main', { slug: 'gpt-5' } as never);
    const listing = await backend.modelList();
    expect(backend.listings).toHaveLength(1);
    expect(listing.data.map((entry) => entry.id)).toContain(model);
    expect((await backend.models()).map((entry) => entry.id)).toEqual(listing.data.map((entry) => entry.id));
  });
});
