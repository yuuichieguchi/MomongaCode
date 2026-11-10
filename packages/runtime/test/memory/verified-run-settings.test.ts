import { describe, expect, it } from 'vitest';
import { createRun, createSession, makeRuntimeFixture, writeProjectSettings, writeUserSettings } from '../process/helpers.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { bash, exported, finishClaimed, checked } from './reflection-fixture.ts';

type Fixture = Awaited<ReturnType<typeof makeRuntimeFixture>>;

const verified = (f: Fixture, runId: string): Promise<boolean> =>
  exported<(deps: unknown, runId: string) => Promise<boolean>>('isRunVerified')({ store: withInProcessFacts(f.store, f.temp.dbPath), settings: f.composition.settings }, runId);

const projectCheckRun = async (f: Fixture) => {
  const session = createSession(f.store, f.temp.project);
  const runId = createRun(f.store, session.id);
  await finishClaimed(f.store, checked('just check', 0));
  return runId;
};

describe('isRunVerified with real settings', () => {
  it('reads the verdict of the conditions pinned when the run started, whatever the settings of the folder say now', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    writeProjectSettings(f.temp.project, { verification: { commands: ['another check'] } });
    const runId = await projectCheckRun(f);
    expect(await verified(f, runId)).toBe(true);
    f.store.trust.set(f.temp.project, 'trusted');
    expect(await verified(f, runId)).toBe(true);
  });

  it('answers a run that declared no condition as not verified, whatever command the model ran', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { verification: { commands: ['just check'] } });
    const session = createSession(f.store, f.temp.project);
    const runId = createRun(f.store, session.id);
    await finishClaimed(f.store, bash('t1', 'just check', 0));
    expect(await verified(f, runId)).toBe(false);
  });

  it('honours a user verification command in any folder', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { verification: { commands: ['just check'] } });
    expect(await verified(f, (await projectCheckRun(f)))).toBe(true);
  });
});

describe('the memory settings port', () => {
  it('ignores project memory settings in an untrusted folder and keeps the design-core-on section 1 defaults there', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    writeProjectSettings(f.temp.project, { memory: { reflection: { enabled: false }, forgetAfterDays: 7, repositoryFacts: false } });
    const session = createSession(f.store, f.temp.project);
    const settings = f.composition.settings as unknown as { memory(session: unknown): Promise<unknown> };
    expect(await settings.memory(session)).toEqual({ reflection: { enabled: true }, forgetAfterDays: 90, repositoryFacts: true });
    f.store.trust.set(f.temp.project, 'trusted');
    expect(await settings.memory(session)).toEqual({ reflection: { enabled: false }, forgetAfterDays: 7, repositoryFacts: false });
  });
});
