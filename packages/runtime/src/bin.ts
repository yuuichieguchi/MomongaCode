import path from 'node:path';
import { nodeEntryIo } from '@momonga/foundation';
import packageJson from '../package.json' with { type: 'json' };
import { runRuntimeEntry } from './process/entry.ts';

const PRODUCT_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'cli', 'src', 'main.ts');

void runRuntimeEntry(nodeEntryIo(), { version: packageJson.version, helperSelf: { execPath: process.execPath, script: PRODUCT_ENTRY } });
