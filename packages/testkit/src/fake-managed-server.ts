import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FakeScenario } from './fake-chat-completions.ts';

export const FAKE_SERVER_ID = 'fake';
export const FAKE_SERVER_MODEL = 'fake-1';
export const FAKE_SERVER_REMEDY = 'set FAKE_KEY';
export const FAKE_SERVER_REFUSAL = 'the fake environment key is not set';
export const FAKE_SERVER_KEY_MISSING_EXIT = 3;

export const FAKE_SERVER = {
  id: FAKE_SERVER_ID,
  provider: 'fake-provider',
  wire: 'chat-completions',
  binary: { defaultPath: '/nonexistent/fake-server' },
  launch: { argv: ['run', '--socket', '{socket}'] },
  endpoint: { forms: ['unix'] },
  ready: { method: 'GET', path: '/ready', status: 200, limitMs: 25_000 },
  preconditions: [
    {
      argv: ['check-env'],
      rules: [
        { exitCode: 0, verdict: 'met', message: 'the fake environment key is set' },
        { exitCode: FAKE_SERVER_KEY_MISSING_EXIT, verdict: 'refused', message: FAKE_SERVER_REFUSAL, remedy: FAKE_SERVER_REMEDY },
        { otherExit: true, verdict: 'refused', message: 'the fake environment check failed' },
      ],
    },
  ],
  identity: ['binarySha256'],
  restart: { backoffMs: 1000, maxRestarts: 5, windowMs: 60_000 },
  models: { listPath: '/models', idPath: ['models', '0', 'name'] },
  toolForms: ['native'],
  tokenCount: 'estimated',
  errors: [{ message: 'fake: input too large', kind: 'context_overflow' }],
  declarable: ['contextWindow', 'maxOutputTokens'],
  recordedDefaults: { stopSequences: true, imageInput: false, tokenCounting: 'estimated', usageReported: true, maxConcurrency: 2 },
  sampling: 'none',
} as const;

export interface FakeManagedServerConfig {
  keySet?: boolean;
  envDumpFile?: string;
  scenario?: FakeScenario;
}

export interface FakeManagedServer {
  binaryPath: string;
  configure(config: FakeManagedServerConfig): void;
}

const TESTKIT_SRC_URL = pathToFileURL(import.meta.dirname).href;

const launcherSource = (): string =>
  [
    `#!${process.execPath}`,
    `import { runFakeManagedServer } from ${JSON.stringify(`${TESTKIT_SRC_URL}/fake-managed-server-main.ts`)};`,
    'await runFakeManagedServer({ configPath: `${import.meta.filename}.json`, argv: process.argv.slice(2) });',
    '',
  ].join('\n');

export const createFakeManagedServer = async ({ dir }: { dir: string }): Promise<FakeManagedServer> => {
  const binaryPath = path.join(dir, 'fake-server');
  let config: FakeManagedServerConfig = { keySet: true };
  const writeConfig = (): void => fs.writeFileSync(`${binaryPath}.json`, JSON.stringify(config));
  await fs.promises.writeFile(binaryPath, launcherSource(), { mode: 0o755 });
  writeConfig();
  return {
    binaryPath,
    configure: (update) => {
      config = { ...config, ...update };
      writeConfig();
    },
  };
};
