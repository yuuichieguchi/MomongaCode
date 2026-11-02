import { nodeCommandRunner, nodeEntryIo } from '@momonga/foundation';
import { daemonEntries } from '../../../packages/cli/src/daemon/entries.ts';
import { describeFailure } from '../../../packages/cli/src/failure.ts';
import { nodePorts } from '../../../packages/cli/src/node-ports.ts';
import { buildProgram, pathsOf } from '../../../packages/cli/src/program.ts';
import { nodeUpdateWiring } from '../../../packages/cli/src/update/wiring.ts';

export const FIXTURE_REPO = 'acme/momonga';
export const FIXTURE_TEAM_ID = 'ABCDE12345';
export const RELEASE_URL_ENV = 'MOMONGA_FIXTURE_RELEASE_URL';
export const REAL_CODESIGN_ENV = 'MOMONGA_FIXTURE_REAL_CODESIGN';

export const runUpdateFixture = async (version: string): Promise<void> => {
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort());
  const ports = nodePorts(version);
  const releaseUrl = process.env[RELEASE_URL_ENV];
  const wiring = nodeUpdateWiring(ports, pathsOf(ports));
  const program = buildProgram({
    ports,
    entries: daemonEntries(ports.self),
    update: {
      ...wiring,
      build: { repo: FIXTURE_REPO, teamId: FIXTURE_TEAM_ID },
      endpoints: releaseUrl === undefined ? wiring.endpoints : { apiBaseUrl: releaseUrl, downloadBaseUrl: releaseUrl },
      ports: {
        ...wiring.ports,
        run: (file, args, options) =>
          file === '/usr/bin/codesign' && process.env[REAL_CODESIGN_ENV] === undefined ? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) : nodeCommandRunner(file, args, options),
      },
    },
    interrupt: interrupt.signal,
    entryIo: (args) => ({ ...nodeEntryIo(), argv: [...args] }),
    complete: (code) => {
      process.exitCode = code;
    },
  });
  try {
    await program.parseAsync();
  } catch (error) {
    process.stderr.write(`momonga: ${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
};
