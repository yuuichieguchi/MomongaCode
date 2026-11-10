import fs from 'node:fs';
import { startFakeChatCompletions } from './fake-chat-completions.ts';
import { FAKE_SERVER_KEY_MISSING_EXIT, FAKE_SERVER_MODEL } from './fake-managed-server.ts';
import type { FakeManagedServerConfig } from './fake-managed-server.ts';

const run = async (argv: readonly string[], config: FakeManagedServerConfig): Promise<void> => {
  const flag = argv.indexOf('--socket');
  const socketPath = flag < 0 ? undefined : argv[flag + 1];
  if (socketPath === undefined) throw new Error('fake-server run requires --socket <path>');
  const server = await startFakeChatCompletions({
    scenario: config.scenario ?? 'tools-ok',
    socketPath,
    modelId: FAKE_SERVER_MODEL,
    staticGets: { '/ready': { ready: true }, '/models': { models: [{ name: FAKE_SERVER_MODEL }] } },
  });
  process.once('SIGTERM', () => {
    void server.close().finally(() => process.exit(0));
  });
};

export const runFakeManagedServer = async ({ configPath, argv }: { configPath: string; argv: readonly string[] }): Promise<void> => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as FakeManagedServerConfig;
  if (config.envDumpFile !== undefined) fs.appendFileSync(config.envDumpFile, `${JSON.stringify({ argv, pid: process.pid })}\n`);
  const [command] = argv;
  if (command === 'run') return run(argv, config);
  if (command === 'check-env') {
    if (config.keySet === false) {
      process.stderr.write('FAKE_KEY is not set\n');
      process.exitCode = FAKE_SERVER_KEY_MISSING_EXIT;
    }
    return;
  }
  process.stderr.write(`fake-server: unknown command ${JSON.stringify(command)}\n`);
  process.exitCode = 2;
};
