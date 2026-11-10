import { autoFitViewOf, readAutoFitRecord } from '@momonga/config';
import type { AutoFitKey } from '@momonga/config';
import type { AutoClassifierView } from '@momonga/protocol';

export const readAutoClassifierView = async ({ model, key, directory }: { model: string; key: AutoFitKey; directory: string }): Promise<AutoClassifierView> =>
  autoFitViewOf(model, key, await readAutoFitRecord(directory, key));
