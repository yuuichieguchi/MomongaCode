import { readAutoFitView } from '@momonga/config';
import type { AutoFitKey } from '@momonga/config';
import type { AutoClassifierView } from '@momonga/protocol';

export const readAutoClassifierView = ({ model, key, directory }: { model: string; key: AutoFitKey; directory: string }): Promise<AutoClassifierView> => readAutoFitView(directory, model, key);
