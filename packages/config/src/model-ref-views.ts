import type { ModelViews } from '@momonga/protocol';
import type { ResolvedModels } from './models.ts';

export const viewsOf = (resolved: ResolvedModels): ModelViews => resolved.views;
