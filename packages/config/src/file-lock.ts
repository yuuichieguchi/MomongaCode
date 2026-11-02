import { comparablePath, sha256Hex } from '@momonga/foundation';
import { layoutOf } from './layout.ts';

const KEY_HEX_CHARS = 32;

export const settingsLockPath = (home: string, file: string): string => `${layoutOf(home).run}/settings-${sha256Hex(comparablePath(file)).slice(0, KEY_HEX_CHARS)}.lock`;
