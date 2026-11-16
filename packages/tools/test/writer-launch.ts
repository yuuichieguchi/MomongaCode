import path from 'node:path';
import type { HelperSelf } from '@momonga/foundation';
import type { WriterLaunch } from '@momonga/tools';

export const TEST_WRITER_LAUNCH: WriterLaunch = { argv: [process.execPath, path.join(import.meta.dirname, 'writer-entry.ts')] };

export const TEST_HELPER_SELF: HelperSelf = { execPath: process.execPath, script: path.resolve(import.meta.dirname, '..', '..', 'cli', 'src', 'main.ts') };
