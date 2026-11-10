import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEAVY_STEPS, LIGHT_STEPS } from '../scripts/support/run-lock.ts';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'RunLock.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const operatorOf = (prefix: string, step: string): string => `${prefix}${step.charAt(0).toUpperCase()}${step.slice(1)}`;

const positionOf = (name: string): number => spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));

describe('the run lock steps in the code are the actions of RunLock.tla', () => {
  it('TB53 names the modelled steps in the order of the model', () => {
    const light = LIGHT_STEPS.map((step) => operatorOf('L', step));
    const heavy = HEAVY_STEPS.map((step) => operatorOf('H', step));

    expect([...light, ...heavy]).toEqual(['LClaimOwn', 'LCheckHeavy', 'HClaimHeavy', 'HScanOne', 'HDecide']);
    for (const steps of [light, heavy]) {
      const positions = steps.map(positionOf);
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });
});
