import path from 'node:path';
import { FIRST_GENERATION, generationLayout } from '@momonga/foundation';
import type { GenerationLayout, MomongaPaths } from '@momonga/foundation';

export const firstGeneration = (paths: MomongaPaths): GenerationLayout => generationLayout(path.dirname(paths.root), FIRST_GENERATION);
