import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BREAKER_ARMS, BREAKER_COOLDOWN, BREAKER_OUTCOMES, BREAKER_STATES } from '../src/core/request-breaker.ts';

const specPath = path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla', 'RequestBreaker.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const STATE_OF_MODEL: Record<string, string> = { closed: 'closed', open: 'open', half: 'half-open' };
const OUTCOME_OF_MODEL: Record<string, string> = { ok: 'success', fail: 'failure', neutral: 'neutral' };

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ${specPath}`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const mapped = (names: readonly string[], table: Record<string, string>): string[] =>
  names.map((name) => {
    const found = table[name];
    if (found === undefined) throw new Error(`the model names "${name}", which the code does not know`);
    return found;
  });

type ModelArm = { from: string; outcome: string; holder: boolean; to: string[] };

const modelArms = (): ModelArm[] => {
  const apply = definitionOf('Apply');
  const arms = apply.split(/^\s*(?:CASE|\[\])\s+/m).slice(1);
  return arms
    .filter((arm) => !arm.startsWith('OTHER'))
    .map((arm) => {
      const [guard, effect] = arm.split('->') as [string, string];
      const from = /brk\[t\] = "(\w+)"/.exec(guard)?.[1];
      const outcome = /v = "(\w+)"/.exec(guard)?.[1];
      if (from === undefined || outcome === undefined) throw new Error(`an arm of Apply has no state or verdict: ${guard}`);
      const assigned = effect.split('\n').find((line) => line.includes("brk' ="));
      const to = assigned === undefined ? [from] : stringsIn(assigned);
      return {
        from: STATE_OF_MODEL[from] as string,
        outcome: OUTCOME_OF_MODEL[outcome] as string,
        holder: guard.includes('holder[r][t]'),
        to: mapped([...new Set(to)], STATE_OF_MODEL).sort(),
      };
    });
};

const key = (arm: { from: string; outcome: string; holder: boolean; to: readonly string[] }): string =>
  `${arm.from}/${arm.outcome}/${arm.holder ? 'holder' : 'any'}->${[...arm.to].sort().join('|')}`;

describe('RequestBreaker.tla against the implementation', () => {
  it('names exactly the states of the breaker', () => {
    expect(mapped(stringsIn(/brk \\in \[TargetIds -> \{[^}]*\}\]/.exec(spec)?.[0] ?? ''), STATE_OF_MODEL).sort()).toEqual([...BREAKER_STATES].sort());
  });

  it('names exactly the outcomes a request can record', () => {
    expect(mapped(stringsIn(definitionOf('Outcomes')), OUTCOME_OF_MODEL).sort()).toEqual([...BREAKER_OUTCOMES].sort());
  });

  it('has exactly the edges of Apply', () => {
    expect(modelArms().map(key).sort()).toEqual(BREAKER_ARMS.map(key).sort());
  });

  it('cools from open to half-open, as Tick does', () => {
    const tick = definitionOf('Tick');
    expect(mapped(stringsIn(tick.slice(0, tick.indexOf('/\\ trial'))), STATE_OF_MODEL)).toEqual([BREAKER_COOLDOWN.from, BREAKER_COOLDOWN.to]);
  });
});
