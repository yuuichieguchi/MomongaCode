import { execFile } from './child-process.ts';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FakeChatCompletionsOptions } from './fake-chat-completions.ts';
import { TEST_UNPROTECTED_LAUNCH } from './test-launch.ts';
import type { ChildLaunch } from '@momonga/foundation';

export const FAKE_OS_BUILD = '25A354';

export interface FakeFmConfig {
  serve?: Partial<Omit<FakeChatCompletionsOptions, 'socketPath'>>;
  envDumpFile?: string;
  serveSurvivorPidFile?: string;
  serveDetachedHelperPidFile?: string;
}

export interface FakeFm {
  binaryPath: string;
  configPath: string;
  configure(config: FakeFmConfig): void;
}

export interface FakeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateFakeFmOptions {
  dir: string;
}

const TESTKIT_SRC_URL = pathToFileURL(import.meta.dirname).href;

const scriptSource = (): string =>
  [
    `#!${process.execPath}`,
    `import { runFakeFm } from ${JSON.stringify(`${TESTKIT_SRC_URL}/fake-fm-main.ts`)};`,
    'await runFakeFm({ configPath: `${import.meta.filename}.json`, argv: process.argv.slice(2) });',
    '',
  ].join('\n');

export const createFakeFm = async ({ dir }: CreateFakeFmOptions): Promise<FakeFm> => {
  const binaryPath = path.join(dir, 'fm');
  const configPath = `${binaryPath}.json`;
  let config: FakeFmConfig = {};
  let writes = 0;
  const writeConfig = (): void => {
    writes += 1;
    const staged = `${configPath}.${process.pid}.${writes}.tmp`;
    fs.writeFileSync(staged, JSON.stringify(config));
    fs.renameSync(staged, configPath);
  };
  await fs.promises.writeFile(binaryPath, scriptSource(), { mode: 0o755 });
  writeConfig();
  return {
    binaryPath,
    configPath,
    configure: (update) => {
      config = { ...config, ...update };
      writeConfig();
    },
  };
};

export const fakeExec = (file: string, args: readonly string[]): Promise<FakeExecResult> => {
  if (path.basename(file) === 'sw_vers' && args.length === 1 && args[0] === '-buildVersion') {
    return Promise.resolve({ exitCode: 0, stdout: `${FAKE_OS_BUILD}\n`, stderr: '' });
  }
  return new Promise((resolve, reject) => {
    execFile(file, [...args], (error, stdout, stderr) => {
      if (error === null) resolve({ exitCode: 0, stdout, stderr });
      else if (typeof error.code === 'number') resolve({ exitCode: error.code, stdout, stderr });
      else reject(error);
    });
  });
};

export const FM_HOST: { readonly platform: NodeJS.Platform; readonly launch: ChildLaunch; readonly exec: typeof fakeExec } = {
  platform: 'darwin',
  launch: TEST_UNPROTECTED_LAUNCH,
  exec: fakeExec,
};
