import { nodeHelperHost } from '../src/node-ports.ts';
import type { HelperMode } from '../src/helper-mode.ts';

export const NO_HELPER: HelperMode = { helpers: async () => ({}), call: undefined, host: nodeHelperHost() };
