import { NETWORK_RELAY_HELPER } from '@momonga/sandbox';
import { executableHelpers } from '@momonga/tools/executable-helpers';

const helper = executableHelpers[NETWORK_RELAY_HELPER];
if (helper === undefined) throw new Error(`no helper named ${NETWORK_RELAY_HELPER}`);
process.exitCode = await helper({ args: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
