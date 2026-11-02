import { nodeEntryIo } from '@momonga/foundation';
import packageJson from '../package.json' with { type: 'json' };
import { runRuntimeEntry } from './process/entry.ts';

void runRuntimeEntry(nodeEntryIo(), { version: packageJson.version });
