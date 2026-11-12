import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings, recordProjectCheck, settingsWriterPorts } from '@momonga/config';
import type { AcceptedCheck } from '@momonga/config';
import { nodeFileSystem } from '@momonga/foundation';
import { checkProposalOf } from '@momonga/runtime';
import { NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';
import { completionPinFor } from '../../src/worker/completion-pin.ts';
import { createRun, createSession, makeRuntimeFixture, writeUserSettings } from '../process/helpers.ts';

type Fixture = Awaited<ReturnType<typeof makeRuntimeFixture>>;

const withTestScript = (project: string): void => {
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
};

const trustedFolder = async (f: Fixture): Promise<void> => {
  await f.store.trust.setAsked(f.temp.project, 'trusted', NEVER_CANCELLED);
};

const settingsOf = async (f: Fixture) =>
  (
    await loadSettings({
      home: f.temp.home,
      projectDir: f.temp.project,
      cli: {},
      trust: { isTrusted: async (directory, signal) => (await f.store.trust.decisionAsked(directory, signal)).decision === 'trusted' },
      signal: NEVER_CANCELLED,
    })
  ).settings;

const proposalOf = async (f: Fixture) => {
  const trusted = (await f.store.trust.decisionAsked(f.temp.project, NEVER_CANCELLED)).decision === 'trusted';
  return checkProposalOf({ projectDir: f.temp.project, trusted, settings: await settingsOf(f), files: nodeFileSystem, signal: NEVER_CANCELLED });
};

const answer = async (f: Fixture, accepted: AcceptedCheck): Promise<void> => {
  await recordProjectCheck(f.temp.home, f.temp.project, accepted, settingsWriterPorts(f.temp.home, { lock: testKernelLock(), signal: NEVER_CANCELLED }));
  await f.cache.load(NEVER_CANCELLED);
};

const pinnedConditionsOf = async (f: Fixture) => {
  const session = createSession(f.store, f.temp.project);
  const run = f.store.getRun(await createRun(f.store, session.id));
  if (run === undefined) throw new Error('the run was not created');
  const outcome = await completionPinFor({ run, session, settings: f.composition.settings, rules: async () => [], mode: 'manual', signal: NEVER_CANCELLED });
  if (outcome.kind !== 'pinned') throw new Error('the pin was refused');
  return outcome.pin.mandate?.completion.conditions ?? [];
};

describe('the check a folder declares is proposed once, after the trust question', () => {
  it('asks in a trusted folder that declares a check and has no answer', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    withTestScript(f.temp.project);
    await trustedFolder(f);
    expect(await proposalOf(f)).toEqual({ ask: true, checks: [{ source: 'package.json', command: 'npm test' }] });
  });

  it('pins an accepted check as a settings condition that runs after a change, and does not ask again', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    withTestScript(f.temp.project);
    await trustedFolder(f);
    await answer(f, { commands: ['npm test'] });
    expect(await proposalOf(f)).toEqual({ ask: false });
    expect(await pinnedConditionsOf(f)).toEqual([expect.objectContaining({ command: 'npm test', when: 'after_mutation', source: 'settings' })]);
  });

  it('keeps a declined answer: no question again and no condition', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    withTestScript(f.temp.project);
    await trustedFolder(f);
    await answer(f, { declined: true });
    expect(await proposalOf(f)).toEqual({ ask: false });
    expect(await pinnedConditionsOf(f)).toEqual([]);
  });

  it('does not ask in a folder that is not trusted', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    withTestScript(f.temp.project);
    expect(await proposalOf(f)).toEqual({ ask: false });
  });

  it('does not ask, and pins no command, in a folder that declares no check', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    await trustedFolder(f);
    expect(await proposalOf(f)).toEqual({ ask: false });
    expect(await pinnedConditionsOf(f)).toEqual([]);
  });
});
