import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { ExecutableHelpers } from '@momonga/foundation';
import { NETWORK_RELAY_HELPER, runNetworkRelay } from '@momonga/sandbox';
import { FILE_WRITER_HELPER, fileWriterOn } from './builtins/file-writer.ts';
import { GIT_ASKPASS_HELPER, gitAskpass } from './operations/askpass-client.ts';

export const runFileWriter = fileWriterOn({ files: nodeFileSystem, random: systemRandom });

export const executableHelpers: ExecutableHelpers = { [GIT_ASKPASS_HELPER]: gitAskpass, [NETWORK_RELAY_HELPER]: runNetworkRelay, [FILE_WRITER_HELPER]: runFileWriter };
