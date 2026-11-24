import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_ID, OTHER_MODEL_ID } from '../../runtime/test/service/helpers.ts';
import { SessionRefused } from '../src/run/resolve-session.ts';
import { createTuiBackend } from '../src/tui/backend.ts';
import type { TuiBackend } from '../src/tui/backend.ts';
import { startRealRuntime } from './real-runtime.ts';
import type { RealRuntime } from './real-runtime.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureSessionDaemon: async () => undefined,
}));

const opened: { runtime: RealRuntime; backend: TuiBackend }[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async ({ runtime, backend }) => {
      await backend.close();
      await runtime.client.close();
    }),
  );
});

const booted = async (): Promise<{ runtime: RealRuntime; backend: TuiBackend }> => {
  const runtime = await startRealRuntime();
  const backend = createTuiBackend(runtime.ports, runtime.paths, {}, { load: async () => [], append: async () => undefined }, [], undefined, undefined);
  opened.push({ runtime, backend });
  await backend.boot();
  return { runtime, backend };
};

describe('the session methods of the real TUI backend, against a real runtime (the daemon start is the one fake)', () => {
  it('opens a session in the folder with the chosen model and mode, and the runtime holds that session', async () => {
    const { runtime, backend } = await booted();

    const session = await backend.openSession(MODEL_ID, 'plan');

    expect(session).toMatchObject({ model: MODEL_ID, permissionMode: 'plan' });
    expect(await runtime.client.getSession(session.id)).toMatchObject({ id: session.id, model: MODEL_ID, permissionMode: 'plan' });
  });

  it('changes the mode and the model of the open session in the runtime', async () => {
    const { runtime, backend } = await booted();
    const session = await backend.openSession(MODEL_ID, undefined);

    expect((await backend.setMode('acceptEdits')).permissionMode).toBe('acceptEdits');
    expect((await backend.setModel(OTHER_MODEL_ID)).model).toBe(OTHER_MODEL_ID);
    expect(await runtime.client.getSession(session.id)).toMatchObject({ model: OTHER_MODEL_ID, permissionMode: 'acceptEdits' });
    expect(await backend.session()).toMatchObject({ id: session.id, model: OTHER_MODEL_ID, permissionMode: 'acceptEdits' });
  });

  it('offers no session that has no run, resumes one by id, and refuses to continue when no session of the folder has worked', async () => {
    const { backend } = await booted();
    const first = await backend.openSession(MODEL_ID, undefined);
    const second = await backend.openSession(MODEL_ID, undefined);

    expect(await backend.sessions()).toEqual([]);
    expect((await backend.resumeSession(first.id)).id).toBe(first.id);
    expect(await backend.runs()).toEqual([]);
    await expect(backend.continueSession()).rejects.toBeInstanceOf(SessionRefused);
    expect(second.id).not.toBe(first.id);
  });
});
