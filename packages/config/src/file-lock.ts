import { sha256Hex } from '@momonga/foundation';
import type { PathResolver } from '@momonga/foundation';
import { layoutOf } from './layout.ts';

const KEY_HEX_CHARS = 32;

export const settingsLockPath = async (home: string, file: string, paths: Pick<PathResolver, 'comparablePath'>): Promise<string> =>
  `${layoutOf(home).run}/settings-${sha256Hex(await paths.comparablePath(file)).slice(0, KEY_HEX_CHARS)}.lock`;
