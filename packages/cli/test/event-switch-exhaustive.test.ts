import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { asChildEvent, noEventTypeLeft } from '../src/run/child-events.ts';

const SOURCE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'run');

const SWITCHES = [
  { name: 'asChildEvent', file: 'child-events.ts', from: 'export const asChildEvent = ', until: undefined },
  { name: 'present', file: 'headless.ts', from: 'const present = ', until: 'const keep = ' },
] as const;

const switchTextOf = (entry: (typeof SWITCHES)[number]): string => {
  const text = readFileSync(path.join(SOURCE_ROOT, entry.file), 'utf8');
  const start = text.indexOf(entry.from);
  const end = entry.until === undefined ? text.length : text.indexOf(entry.until, start);
  if (start < 0 || end <= start) throw new Error(`the switch ${entry.name} was not found in ${entry.file}`);
  return text.slice(start, end);
};

type AddedMember = { type: 'fixture.added'; runId: string };

export const unionWithAnAddedMember = (event: PublicRunEvent | AddedMember): void => {
  if (event.type !== 'fixture.added') return;
  // @ts-expect-error a member of the union that no case names is not assignable to never, so the switch that ends in this check does not compile
  noEventTypeLeft(event);
};

const eventOf = (type: string): PublicRunEvent => ({ type, id: 1, seq: 1, step: 0, createdAt: 0, sessionId: 's', runId: 'r', callId: 'c', callIds: ['c'], title: 't' }) as unknown as PublicRunEvent;

describe('the event switches of the headless run', () => {
  it.each(SWITCHES)('$name names every event type of the protocol', (entry) => {
    const text = switchTextOf(entry);
    expect(EVENT_TYPES.filter((type) => !text.includes(`case '${type}':`))).toEqual([]);
  });

  it.each(SWITCHES)('$name ends in the never check, not in a default that passes any type', (entry) => {
    const text = switchTextOf(entry);
    expect(text).not.toMatch(/default:\s*(?:break|return undefined);/);
    expect(text).toMatch(/default:\s*(?:return )?noEventTypeLeft\(event\);/);
  });

  it('asChildEvent answers every event type with that event or with nothing', () => {
    for (const type of EVENT_TYPES) {
      const shown = asChildEvent(eventOf(type), 'helper');
      expect(shown === undefined || shown.type === type).toBe(true);
    }
  });

  it('an event form this build does not know is shown by neither switch and stops nothing', () => {
    expect(asChildEvent(eventOf('later.build.event'), 'helper')).toBeUndefined();
    expect(unionWithAnAddedMember({ type: 'fixture.added', runId: 'r' })).toBeUndefined();
  });
});
