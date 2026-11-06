import { autoFitViewOf, readAutoFitRecord } from '@momonga/config';
import type { AutoFitKey } from '@momonga/config';
import type { AutoClassifierView } from '@momonga/protocol';

export const readAutoClassifierView = async ({ alias, key, directory }: { alias: string; key: AutoFitKey; directory: string }): Promise<AutoClassifierView> =>
  autoFitViewOf(alias, key, await readAutoFitRecord(directory, key));
