import { describe, expect, it } from 'vitest';
import { renderMemories } from '../src/memory.ts';

describe('the memory block states the touched-path bound of the recall', () => {
  it('names how many of the newest touched paths chose the notes', () => {
    expect(renderMemories([], 0, { touchedCap: 7 })).toContain('Only the newest 7 touched paths were used, with the request of the run, to choose the notes shown; earlier touched paths were not used.');
  });

  it('says nothing about touched paths when no bound applied', () => {
    expect(renderMemories([], 0, {})).not.toContain('touched paths');
  });
});
