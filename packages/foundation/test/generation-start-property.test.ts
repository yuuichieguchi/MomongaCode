import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { GenerationPrepareError, beginGenerationStart, ensureMomongaDirs, generationLayout, momongaPaths, nodeGenerationStartFiles, publishCurrentGeneration } from '@momonga/foundation';
import type { GenerationStartFiles, MomongaPaths } from '@momonga/foundation';
import { PROPERTY_TIMEOUT_MS, createFakeKernelLock, withTempDir, testKernelLock } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const seeded = (seed: number): ((bound: number) => number) => {
  let state = seed;
  return (bound) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % bound;
  };
};

const setup = async (context: TestContext): Promise<{ home: string; paths: MomongaPaths }> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  return { home, paths };
};

const generationDirs = (paths: MomongaPaths): string[] => fs.readdirSync(paths.run).filter((entry) => /^g\d+$/.test(entry)).sort();

const counterOf = (paths: MomongaPaths): number => Number(fs.readFileSync(paths.generationCounter, 'utf8').trim());

describe('run/current only moves up (CurrentOnlyByPromotion, CurVersionMonotone)', () => {
  it('keeps run/current at the running maximum with a version that never decreases, over seeded publish sequences', async (context) => {
    const next = seeded(20261110);
    for (let sequence = 0; sequence < 25; sequence += 1) {
      const { home, paths } = await setup(context);
      let highest = 0;
      for (let step = 0, steps = 1 + next(20); step < steps; step += 1) {
        const generation = 1 + next(6);
        const outcome = await publishCurrentGeneration(paths, { generation, version: `1.0.${generation}`, sockets: generationLayout(home, generation).sockets }, { lock: testKernelLock() });
        expect(outcome).toBe(generation > highest ? 'published' : 'superseded');
        highest = Math.max(highest, generation);
        expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: highest, version: `1.0.${highest}` });
      }
    }
  });
});

describe('numbers are never reused (NoNumberReuse)', () => {
  it('allocates above every number allocated or recorded before, over seeded sequences of starts, failed starts and removals', async (context) => {
    const next = seeded(71);
    const failingDirs: GenerationStartFiles = { ...nodeGenerationStartFiles, createGenerationDirs: async () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })) };
    for (let sequence = 0; sequence < 15; sequence += 1) {
      const { paths } = await setup(context);
      let highest = 0;
      let counterRemoved = false;
      for (let step = 0, steps = 1 + next(30); step < steps; step += 1) {
        const lock = createFakeKernelLock({ inheritable: false });
        const action = next(4);
        if (action === 0) {
          const outcome = await beginGenerationStart(paths, { version: `1.0.${1 + next(3)}`, foldVersion: 1, lock, trigger: 'restart' });
          if (outcome.kind !== 'allocated') throw new Error(`unexpected outcome ${outcome.kind}`);
          if (!counterRemoved) expect(outcome.generation).toBeGreaterThan(highest);
          expect(generationDirs(paths)).toContain(`g${outcome.generation}`);
          highest = Math.max(highest, outcome.generation);
          counterRemoved = false;
        } else if (action === 1) {
          const failure = await beginGenerationStart(paths, { version: '1.0.1', foldVersion: 1, lock, trigger: 'restart', files: failingDirs }).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(GenerationPrepareError);
          highest = Math.max(highest, counterOf(paths));
          counterRemoved = false;
        } else if (action === 2) {
          const [first] = generationDirs(paths);
          if (first !== undefined) fs.rmSync(path.join(paths.run, first), { recursive: true });
        } else if (generationDirs(paths).length === 0) {
          fs.rmSync(paths.generationCounter, { force: true });
          counterRemoved = true;
        }
      }
    }
  });
});
