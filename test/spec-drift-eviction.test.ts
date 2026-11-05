import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tlaDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(tlaDir, 'RequestPrefix.tla'), 'utf8');
const mainConfig = fs.readFileSync(path.join(tlaDir, 'RequestPrefix.cfg'), 'utf8');

const definitionOf = (name: string): string => {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}(\\(.*\\))?\\s*==`).test(line));
  if (start < 0) throw new Error(`RequestPrefix.tla defines no ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line !== '' && !/^\s/.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
};

const checkedIn = (config: string): string[] => {
  const names: string[] = [];
  let section: string | undefined;
  for (const line of config.split('\n')) {
    const header = /^(INVARIANTS?|PROPERTIES|PROPERTY)\b/.exec(line);
    if (header !== null) {
      section = header[1];
      continue;
    }
    if (/^\S/.test(line)) section = undefined;
    const name = line.trim();
    if (section !== undefined && name !== '') names.push(name);
  }
  return names;
};

describe('RequestPrefix.tla states the eviction and reference rules the code implements (review C-4, C-6)', () => {
  it('never makes a reference rendering an eviction candidate (build-context.ts evictOldest skips state.reference)', () => {
    const candidate = definitionOf('Candidate');
    expect(candidate).toMatch(/dupOf\s*=\s*0/);
    expect(candidate).toMatch(/~\s*it\.evicted/);
    expect(definitionOf('Evict')).toMatch(/Candidate\(/);
  });

  it('lets an eviction pass skip a candidate whose omitted marker is not smaller, or whose eviction gains nothing under C2', () => {
    const noGain = definitionOf('NoGain');
    expect(noGain.length).toBeGreaterThan(0);
    expect(definitionOf('Evict')).toMatch(/NoGain\(/);
    expect(definitionOf('Evict')).not.toMatch(/Cardinality\(\{j \\in UnprotectedIdx : j <= i\}\) <= k/);
  });

  it('states OldestFirst as the code rule: every older candidate is evicted too, or was skipped for no gain', () => {
    const oldestFirst = definitionOf('OldestFirst');
    expect(oldestFirst).toMatch(/Candidate\(/);
    expect(oldestFirst).toMatch(/NoGain\(/);
  });

  it('prices a referent and its unprotected copies as one candidate, with no promotion to price (item 2, corrected)', () => {
    expect(definitionOf('NoGain')).not.toMatch(/dupOf/);
    const group = definitionOf('GroupOf');
    expect(group).toMatch(/dupOf\s*=\s*h\[i\]\.id/);
    expect(group).toMatch(/step\s*<=\s*step\s*-\s*Keep/);
    expect(definitionOf('Evict')).toMatch(/GroupOf\(hist,\s*first\)/);
    expect(definitionOf('Evict')).toMatch(/i \\in group THEN \[hist\[i\] EXCEPT !\.evicted = TRUE\]/);
    expect(definitionOf('OldestFirst')).toMatch(/CandidatePosition\(hist, i\)/);
    expect(definitionOf('CandidatePosition')).toMatch(/h\[k\]\.id = h\[i\]\.dupOf/);
  });

  it('checks the group rule in an every-run configuration, and an evidence configuration that evicts protected copies violates NoProtectedEvicted', () => {
    const groups = fs.readFileSync(path.join(tlaDir, 'RequestPrefix.groups.cfg'), 'utf8');
    const evidence = fs.readFileSync(path.join(tlaDir, 'RequestPrefix.protectedCopies.cfg'), 'utf8');
    expect(groups).toMatch(/EvictProtectedCopies = FALSE/);
    expect(groups).toMatch(/RefModel = TRUE/);
    expect(checkedIn(groups)).toContain('NoProtectedEvicted');
    expect(evidence).toMatch(/EvictProtectedCopies = TRUE/);
    expect(checkedIn(evidence)).toContain('NoProtectedEvicted');
    expect(mainConfig).toMatch(/EvictProtectedCopies = FALSE/);
  });

  it('makes the next full copy the referent when a referent stops being full, instead of sending every referrer to full', () => {
    const evict = definitionOf('Evict');
    expect(evict).toMatch(/NextReferent\(/);
    expect(evict).not.toMatch(/dupOf\s*=\s*IF\s+hist\[i\]\.dupOf\s*\\in\s*goneIds\s*THEN\s*0/);
    expect(evict).not.toMatch(/!\.dupOf\s*=\s*0\]/);
    expect(definitionOf('NextReferent')).toMatch(/Full\(/);
  });

  it('counts an output as full only when it is neither evicted nor truncated, and checks references against that notion', () => {
    const full = definitionOf('Full');
    expect(full).toMatch(/evicted/);
    expect(full).toMatch(/Truncated\(/);
    expect(definitionOf('RefShowsFullReferent')).toMatch(/Full\(/);
  });

  it('checks the restated rules and RefNeverEvicted in the every-run configuration', () => {
    const checked = checkedIn(mainConfig);
    expect(checked).toEqual(expect.arrayContaining(['OldestFirst', 'RefShowsFullReferent', 'RefNeverEvicted']));
    expect(definitionOf('RefNeverEvicted')).toMatch(/dupOf/);
  });
});
