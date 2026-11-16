import type { ExecutableHelpers } from '@momonga/foundation';
import { NETWORK_RELAY_HELPER, runNetworkRelay } from '@momonga/sandbox';
import { FILE_WRITER_HELPER } from './builtins/file-writer.ts';
import { runFileWriter } from './node-ports.ts';
import { GIT_ASKPASS_HELPER, gitAskpass } from './operations/askpass-client.ts';

export const executableHelpers: ExecutableHelpers = { [GIT_ASKPASS_HELPER]: gitAskpass, [NETWORK_RELAY_HELPER]: runNetworkRelay, [FILE_WRITER_HELPER]: runFileWriter };
