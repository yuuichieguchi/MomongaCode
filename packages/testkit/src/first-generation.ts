import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FIRST_GENERATION, MARKER_KINDS, STARTUP_TIMEOUT_MS, beginGenerationStart, canonicalPath, ensureMomongaDirs, formatStartRecord, generationLayout, hostKernelLock, momongaPaths, scopeToGeneration } from '@momonga/foundation';
import type { GenerationLayout, KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';

export const firstGeneration = (paths: MomongaPaths): GenerationLayout => generationLayout(path.dirname(paths.root), FIRST_GENERATION);

const PRIVATE_DIRECTORY = { recursive: true, mode: 0o700 } as const;

export const prepareGenerationForTest = (home: string, generation: number, version: string): GenerationLayout => {
  const canonicalHome = canonicalPath(home);
  const layout = generationLayout(canonicalHome, generation);
  const scoped = scopeToGeneration(momongaPaths(canonicalHome, process.platform, {}), generation);
  fs.mkdirSync(layout.dir, PRIVATE_DIRECTORY);
  for (const kind of MARKER_KINDS) fs.mkdirSync(scoped.markers[kind], PRIVATE_DIRECTORY);
  fs.writeFileSync(layout.startRecord, formatStartRecord({ version, foldVersion: FIDELITY_FOLD_VERSION }), { mode: 0o600 });
  return layout;
};

const START_RETRY_MS = 25;

export type StartedGenerationForTest = { generation: number; layout: GenerationLayout; release(): void };

export const startGenerationForTest = async (home: string, options: { version: string; lock?: KernelLockMechanism }): Promise<StartedGenerationForTest> => {
  const canonicalHome = canonicalPath(home);
  const paths = momongaPaths(canonicalHome, process.platform, {});
  await ensureMomongaDirs(paths);
  const lock = options.lock ?? hostKernelLock();
  for (let waited = 0; waited <= STARTUP_TIMEOUT_MS; waited += START_RETRY_MS) {
    const outcome = await beginGenerationStart(paths, { version: options.version, foldVersion: FIDELITY_FOLD_VERSION, lock, trigger: 'restart' });
    if (outcome.kind === 'allocated') return { generation: outcome.generation, layout: generationLayout(canonicalHome, outcome.generation), release: outcome.starting.release };
    await delay(START_RETRY_MS);
  }
  throw new Error(`the generation lock of ${canonicalHome} stayed busy for ${STARTUP_TIMEOUT_MS} ms`);
};
