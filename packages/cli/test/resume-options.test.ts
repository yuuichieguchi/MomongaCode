import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_CONFIG, EXIT_USAGE } from '@momonga/foundation';
import { TARGET_NOT_READY, messageOf } from '@momonga/protocol';
import type { MomongaModelList } from '@momonga/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_ID, OTHER_MODEL_ID } from '../../runtime/test/service/helpers.ts';
import { exitOfFailure } from '../src/program.ts';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { openSession } from '../src/run/open-session.ts';
import type { SessionOptions } from '../src/run/open-session.ts';
import { SessionRefused, resolveSession } from '../src/run/resolve-session.ts';
import { UsageError } from '../src/usage-error.ts';
import { startRealRuntime } from './real-runtime.ts';
import type { RealRuntime } from './real-runtime.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureSessionDaemon: async () => undefined,
}));

const opened: RealRuntime[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(opened.splice(0).map((runtime) => runtime.client.close()));
});

const started = async (): Promise<RealRuntime> => {
  const runtime = await startRealRuntime();
  opened.push(runtime);
  return runtime;
};

const CONNECTED: Pick<MomongaModelList, 'data' | 'start'> = { data: [{ id: MODEL_ID }] as unknown as MomongaModelList['data'], start: MODEL_ID };

const NOT_CONNECTED: Pick<MomongaModelList, 'data' | 'start'> = { data: [], start: null };

const reopened = async (runtime: RealRuntime, id: string, typed: SessionOptions, listed = CONNECTED) => {
  const session = await openSession(runtime.ports, runtime.paths, { signal: new AbortController().signal, reopen: { kind: 'id', id }, modelList: async () => listed, ...typed });
  closers.push(() => session.close());
  return session.created.session;
};

const codeOf = (error: unknown): number => exitOfFailure(error, { write: () => true });

describe('a resume applies each option the person typed, or refuses it by name', () => {
  it('--resume <id> --model changes the model of the stored session', async () => {
    const runtime = await started();
    const stored = await runtime.service.createSession();
    expect(stored.model).toBe(MODEL_ID);

    const session = await reopened(runtime, stored.id, { model: OTHER_MODEL_ID });

    expect(session).toMatchObject({ id: stored.id, model: OTHER_MODEL_ID });
    expect((await runtime.client.getSession(stored.id)).model).toBe(OTHER_MODEL_ID);
  });

  it('--resume <id> --permission-mode changes the mode, and a resume with neither leaves the session as it is stored', async () => {
    const runtime = await started();
    const stored = await runtime.service.createSession();

    expect(await reopened(runtime, stored.id, {})).toMatchObject({ id: stored.id, model: MODEL_ID, permissionMode: 'manual' });
    expect(await reopened(runtime, stored.id, { permissionMode: 'acceptEdits' })).toMatchObject({ permissionMode: 'acceptEdits' });
    expect((await runtime.client.getSession(stored.id)).permissionMode).toBe('acceptEdits');
  });

  it('a model no server lists is refused by the runtime and neither option is applied', async () => {
    const runtime = await started();
    const stored = await runtime.service.createSession();

    await expect(reopened(runtime, stored.id, { model: 'no-such-model', permissionMode: 'acceptEdits' })).rejects.toMatchObject({ status: 400 });

    expect(await runtime.client.getSession(stored.id)).toMatchObject({ model: MODEL_ID, permissionMode: 'manual' });
  });
});

describe('a session stored in the bypass mode is reopened in it only with the opt-in of this invocation', () => {
  const storedInBypass = async () => {
    const runtime = await started();
    const stored = await runtime.service.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    expect(stored.permissionMode).toBe('bypassPermissions');
    return { runtime, stored };
  };

  it('is refused as a usage error that names the option when the invocation gives no opt-in', async () => {
    const { runtime, stored } = await storedInBypass();

    const failure = await reopened(runtime, stored.id, {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toContain('--dangerously-skip-permissions');
    expect((failure as Error).message).toContain(stored.id);
    expect(codeOf(failure)).toBe(EXIT_USAGE);
    expect((await runtime.client.getSession(stored.id)).permissionMode).toBe('bypassPermissions');
  });

  it('is reopened in the bypass mode with the opt-in, and in the mode the person typed without it', async () => {
    const { runtime, stored } = await storedInBypass();

    expect(await reopened(runtime, stored.id, { permissionMode: 'bypassPermissions', bypassAllowed: true })).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(await reopened(runtime, stored.id, { permissionMode: 'manual' })).toMatchObject({ permissionMode: 'manual' });
  });

  it('a session that was not started with the opt-in is not moved into the bypass mode by a resume: refused by name', async () => {
    const runtime = await started();
    const stored = await runtime.service.createSession();

    const failure = await reopened(runtime, stored.id, { permissionMode: 'bypassPermissions', bypassAllowed: true }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toContain('--dangerously-skip-permissions');
    expect((await runtime.client.getSession(stored.id)).permissionMode).toBe('manual');
  });
});

describe('readiness is decided before a resume is resolved', () => {
  it('a resume with no model connected is refused as not ready, and the session id is not looked up', async () => {
    const runtime = await started();
    const failure = await reopened(runtime, 'ffffffff-no-such-session', {}, NOT_CONNECTED).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(SessionRefused);
    expect(failure).toMatchObject({ code: TARGET_NOT_READY, reason: messageOf('noModelConnected', 'cli') });
  });

  it('a headless --resume with no model connected reports that no model is ready, in both formats, and ends with a failure', async () => {
    const runtime = await started();
    const options = { prompt: async () => 'go on', format: 'json', verbose: false, interrupt: new AbortController().signal, reopen: { kind: 'id', id: 'ffffffff-no-such-session' }, capabilitiesOf: async () => { throw new Error('the capabilities of no model are read'); }, modelList: async () => NOT_CONNECTED } as unknown as HeadlessOptions;

    expect(await runHeadless(runtime.ports, runtime.paths, options)).toBe(EXIT_CONFIG);

    expect(runtime.stderr.join('')).toContain(messageOf('noModelConnected', 'cli'));
    expect(runtime.stderr.join('')).not.toContain('No session has the id');
    expect(JSON.parse(runtime.stdout.join(''))).toMatchObject({ type: 'result', is_error: true, error: { code: TARGET_NOT_READY } });
  });
});

describe('the command a refusal prints for a session of another folder', () => {
  it.skipIf(process.platform === 'win32')('quotes the folder so that the shell reads it back as the same folder', async () => {
    const runtime = await started();
    const awkward = path.join(runtime.service.layout.root, "it's a folder; $(touch pwned) `x`");
    fs.mkdirSync(awkward);
    const elsewhere = await runtime.service.createSession({ cwd: awkward });

    const failure = await resolveSession(runtime.client, runtime.service.layout.project, elsewhere.id, process.platform).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionRefused);
    const command = /Run: (cd .*) && momonga --resume /s.exec((failure as Error).message)?.[1];
    if (command === undefined) throw new Error(`the refusal prints no command: ${(failure as Error).message}`);
    const landed = execFileSync('/bin/sh', ['-c', `${command} && pwd -P`], { encoding: 'utf8', cwd: runtime.service.layout.root });
    expect(landed.trimEnd()).toBe(fs.realpathSync(awkward));
    expect(fs.existsSync(path.join(runtime.service.layout.root, 'pwned'))).toBe(false);
  });

  it('leaves a plain folder as it is', async () => {
    const sessions = { listSessions: async (cwd?: string) => (cwd === undefined ? [{ id: '0123456789abcdef', cwd: '/work/other' }] : []) };

    await expect(resolveSession(sessions as never, '/work/project', '0123456789abcdef', process.platform)).rejects.toThrow('Run: cd /work/other && momonga --resume 0123456789abcdef');
  });
});
