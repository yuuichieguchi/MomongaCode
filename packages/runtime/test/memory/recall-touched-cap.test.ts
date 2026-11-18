import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../worker/harness.ts';
import { SIGNAL, newCounter, portFor, seededStore } from './recall-fixture.ts';

const CAPACITY = { capabilities: capabilitiesFor(200_000) };

describe('the recall keeps the touched-path bound of its query', () => {
  it('reports the bound it was prepared with and drops it at the next unbounded prepare', async () => {
    const seeded = await seededStore(1, (index) => `the parser note ${index}`);
    const set = await portFor(seeded.store, newCounter()).load(seeded.session, SIGNAL);
    await set.prepare({ query: 'parser', capacity: CAPACITY, touchedCap: 3 });
    expect(set.touchedCap()).toBe(3);
    await set.prepare({ query: 'parser', capacity: CAPACITY });
    expect(set.touchedCap()).toBeUndefined();
  });
});
