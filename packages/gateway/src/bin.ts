import { nodeEntryIo } from '@momonga/foundation';
import packageJson from '../package.json' with { type: 'json' };
import { runGatewayEntry } from './entry.ts';

void runGatewayEntry(nodeEntryIo(), { version: packageJson.version });
