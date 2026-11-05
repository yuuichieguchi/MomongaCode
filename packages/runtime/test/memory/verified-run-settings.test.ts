import { describe, expect, it } from 'vitest';
import { createRun, createSession, makeRuntimeFixture, writeProjectSettings, writeUserSettings } from '../process/helpers.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { bash, exported, finishClaimed } from './reflection-fixture.ts';

type Fixture = Awaited<ReturnType<typeof makeRuntimeFixture>>;

const verified = (f: Fixture, runId: string): Promise<boolean> =>
  exported<(deps: unknown, runId: string) => Promise<boolean>>('isRunVerified')({ store: withInProcessFacts(f.store, f.temp.dbPath), settings: f.composition.settings }, runId);

const projectCheckRun = async (f: Fixture) => {
  const session = createSession(f.store, f.temp.project);
  const runId = createRun(f.store, session.id);
  await finishClaimed(f.store, bash('t1', 'just check', 0));
  return runId;
};

describe('isRunVerified with real settings', () => {
  it('honours a project verification command only in a trusted folder', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    writeProjectSettings(f.temp.project, { verification: { commands: ['just check'] } });
    const runId = projectCheckRun(f);
    expect(await verified(f, (await runId))).toBe(false);
    f.store.trust.set(f.temp.project, 'trusted');
    expect(await verified(f, (await runId))).toBe(true);
  });

  it('honours a user verification command in any folder', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { verification: { commands: ['just check'] } });
    expect(await verified(f, (await projectCheckRun(f)))).toBe(true);
  });
});

describe('the memory settings port', () => {
  it('ignores project memory settings in an untrusted folder', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    writeProjectSettings(f.temp.project, { memory: { reflection: { enabled: true }, forgetAfterDays: 7 } });
    const session = createSession(f.store, f.temp.project);
    const settings = f.composition.settings as unknown as { memory(session: unknown): Promise<unknown> };
    expect(await settings.memory(session)).toEqual({ reflection: { enabled: false }, forgetAfterDays: 90, repositoryFacts: false });
    f.store.trust.set(f.temp.project, 'trusted');
    expect(await settings.memory(session)).toEqual({ reflection: { enabled: true }, forgetAfterDays: 7, repositoryFacts: false });
  });
});
