import { describe, expect, it } from 'vitest';
import { makeDifferentialWorkspace } from './differential/fixture.ts';
import { generate, seededRng } from './differential/generator.ts';
import { runCase } from './differential/oracles.ts';
import type { Case } from './differential/oracles.ts';
import { PLACEHOLDER_PATHS, editSeeds, readSeeds } from './differential/seeds.ts';

const SEED_CHUNK = 8;
const GENERATED_SEEDS = [1, 2, 3, 4, 5, 6];
const CASES_PER_SEED = 24;

const failures = async (cases: readonly Case[], run: (input: Case) => ReturnType<typeof runCase>): Promise<{ approved: number; failures: string[] }> => {
  const found: string[] = [];
  let approved = 0;
  for (const input of cases) {
    const outcome = await run(input);
    if (outcome.ran) approved += 1;
    for (const violation of outcome.violations) found.push(`${JSON.stringify(input)}: ${violation}`);
  }
  return { approved, failures: found };
};

describe('every command decide approves does what the analysis reported, on real /bin/bash and real git', () => {
  const readCount = readSeeds(PLACEHOLDER_PATHS).length;

  it.each(Array.from({ length: Math.ceil(readCount / SEED_CHUNK) }, (_, chunk) => chunk))('bypasses reported in both review rounds, chunk %i', async (chunk) => {
    const workspace = makeDifferentialWorkspace();
    const cases = readSeeds(workspace).slice(chunk * SEED_CHUNK, (chunk + 1) * SEED_CHUNK);
    expect((await failures(cases, (input) => runCase(workspace, input))).failures).toEqual([]);
  });

  it.each(Array.from({ length: editSeeds(PLACEHOLDER_PATHS).length },(_, index) => index))('repositories created by the same command, case %i', async (index) => {
    const workspace = makeDifferentialWorkspace();
    const input = editSeeds(workspace)[index] as Case;
    expect((await runCase(workspace, input)).violations, input.command).toEqual([]);
  });

  it.each(GENERATED_SEEDS)('seeded generator, seed %i', async (seed) => {
    const workspace = makeDifferentialWorkspace();
    const cases = generate(seededRng(seed), workspace, CASES_PER_SEED);
    const result = await failures(cases, (input) => runCase(workspace, input));
    expect(result.failures).toEqual([]);
    expect(result.approved).toBeGreaterThan(0);
  });
});
