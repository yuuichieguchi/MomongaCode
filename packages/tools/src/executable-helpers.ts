import type { ExecutableHelpers } from '@momonga/foundation';
import { GIT_ASKPASS_HELPER, gitAskpass } from './operations/askpass-client.ts';

export const executableHelpers: ExecutableHelpers = { [GIT_ASKPASS_HELPER]: gitAskpass };
