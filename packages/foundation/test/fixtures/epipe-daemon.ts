import { nodeEntryIo, runDaemonEntry } from '../../src/index.ts';
import { epipeDaemon } from './epipe-daemon-definition.ts';

await runDaemonEntry(nodeEntryIo(), epipeDaemon);
