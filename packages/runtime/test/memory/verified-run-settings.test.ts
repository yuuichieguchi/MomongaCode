import { describe, expect, it } from 'vitest';
import { createRun, createSession, makeRuntimeFixture, writeProjectSettings, writeUserSettings } from '../process/helpers.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { bash, finishClaimed, checked } from './reflection-fixture.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

type Fixture = Awaited<ReturnType<typeof makeRuntimeFixture>>;

const verified = async (f: Fixture, runId: string): Promise<boolean> => {
  const store = withInProcessFacts(f.store, f.temp.dbPath);
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`run ${runId} does not exist`);
  const session = store.getSession(run.sessionId);
  if (session === undefined) throw new Error(`session ${run.sessionId} does not exist`);
  const verification = await f.composition.settings.verification(session, NEVER_CANCELLED);
  return (await store.journalFacts.verdict({ runId, commands: verification.conditions, manifests: verification.manifests })).verified;
};

const projectCheckRun = async (f: Fixture) => {
  const session = createSession(f.store, f.temp.project);
  const runId = await createRun(f.store, session.id);
  await finishClaimed(f.store, checked('just check', 0));
  return runId;
};

describe('the verdict of a run with real settings', () => {
  it('reads the verdict of the conditions pinned when the run started, whatever the settings of the folder say now', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    writeProjectSettings(f.temp.project, { verification: { commands: ['another check'] } });
    const runId = await projectCheckRun(f);
    expect(await verified(f, runId)).toBe(true);
    await f.store.trust.setAsked(f.temp.project, 'trusted', NEVER_CANCELLED);
    expect(await verified(f, runId)).toBe(true);
  });

  it('answers a run that declared no condition as not verified, whatever command the model ran', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { verification: { commands: ['just check'] } });
    const session = createSession(f.store, f.temp.project);
    const runId = await createRun(f.store, session.id);
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
    const settings = f.composition.settings as unknown as { memory(session: unknown, signal: AbortSignal): Promise<unknown> };
    expect(await settings.memory(session, NEVER_CANCELLED)).toEqual({ reflection: { enabled: true }, forgetAfterDays: 90, repositoryFacts: true, autoReview: false });
    await f.store.trust.setAsked(f.temp.project, 'trusted', NEVER_CANCELLED);
    expect(await settings.memory(session, NEVER_CANCELLED)).toEqual({ reflection: { enabled: false }, forgetAfterDays: 7, repositoryFacts: false, autoReview: false });
  });
});
