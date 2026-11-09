import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAtomicWriteTemporary, sweepLeftovers, writeFileAtomically } from '@momonga/foundation';
import type { LeftoverDirectory, PublishMode } from '@momonga/foundation';
import { createFakeRandom } from '@momonga/testkit';
import { ProcessCrashed, SIDECAR_SUFFIX, createWorld } from './support/leftover-world.ts';
import type { StepControl, World, WorldActor, WorldLockForm } from './support/leftover-world.ts';

const DIRECTORY = path.join(path.sep, 'home', 'state');
const FINAL_NAME = 'final.json';
const FINAL = path.join(DIRECTORY, FINAL_NAME);
const CONTENT = '{"written":true}';
const FORMS: readonly WorldLockForm[] = ['entry', 'sidecar'];
const MODES: readonly PublishMode[] = ['replace', 'create'];
const REGISTERED: readonly LeftoverDirectory[] = [{ directory: DIRECTORY, isLeftover: isAtomicWriteTemporary }];

const write = (writer: WorldActor, publish: PublishMode, seed = 7): Promise<unknown> =>
  writeFileAtomically(writer.files, createFakeRandom(seed), FINAL, CONTENT, { mode: 0o600, publish, lock: writer.lock });

const writeUntilCrash = async (writer: WorldActor, publish: PublishMode, seed = 7): Promise<void> => {
  try {
    await write(writer, publish, seed);
  } catch (error) {
    if (!(error instanceof ProcessCrashed)) throw error;
  }
};

const sweep = (world: World): Promise<unknown> => {
  const sweeper = world.actor('sweeper');
  return sweepLeftovers({ directories: REGISTERED, lock: sweeper.lock, files: sweeper.files });
};

const unitsOf = (names: readonly string[]): Set<string> =>
  new Set(names.filter((name) => name !== FINAL_NAME).map((name) => (name.endsWith(SIDECAR_SUFFIX) ? name.slice(0, -SIDECAR_SUFFIX.length) : name)));

const stepsOfCompleteWrite = async (form: WorldLockForm, publish: PublishMode): Promise<readonly string[]> => {
  const world = createWorld(form, [DIRECTORY]);
  const writer = world.actor('writer');
  await write(writer, publish);
  return writer.steps();
};

const freshWriter = (form: WorldLockForm, control: StepControl): { world: World; writer: WorldActor } => {
  const world = createWorld(form, [DIRECTORY]);
  return { world, writer: world.actor('writer', control) };
};

describe('C1: the atomic write creates its temporary locked, under a unique name, and unlinks it before release', () => {
  for (const form of FORMS) {
    for (const publish of MODES) {
      it(`${form} form, ${publish}: the temporary is named .<file>.<random>.tmp in the final file's directory`, async () => {
        const steps = await stepsOfCompleteWrite(form, publish);
        const claimed = steps.find((step) => step.startsWith('claim '));
        expect(claimed).toBeDefined();
        const lockName = (claimed as string).slice('claim '.length);
        const temporary = lockName.endsWith(SIDECAR_SUFFIX) ? lockName.slice(0, -SIDECAR_SUFFIX.length) : lockName;
        expect(temporary).toMatch(/^\.final\.json\.[0-9a-f]+\.tmp$/);
        expect(isAtomicWriteTemporary(temporary)).toBe(true);
        expect(isAtomicWriteTemporary(FINAL_NAME)).toBe(false);
      });

      it(`${form} form, ${publish}: the lock is claimed before the temporary's name exists, and released only after its lock file is unlinked`, async () => {
        const steps = await stepsOfCompleteWrite(form, publish);
        const firstClaim = steps.findIndex((step) => step.startsWith('claim '));
        const firstOpen = steps.findIndex((step) => step.startsWith('open w'));
        expect(firstClaim).toBeGreaterThanOrEqual(0);
        expect(firstClaim).toBeLessThan(firstOpen === -1 ? Number.POSITIVE_INFINITY : firstOpen);
        const claimed = (steps[firstClaim] as string).slice('claim '.length);
        const release = steps.indexOf(`release ${claimed}`);
        expect(release).toBeGreaterThan(firstClaim);
        if (form === 'sidecar') expect(steps.indexOf(`unlink ${claimed}`)).toBeLessThan(release);
      });

      it(`${form} form, ${publish}: a complete write leaves exactly the final file`, async () => {
        const world = createWorld(form, [DIRECTORY]);
        await write(world.actor('writer'), publish);
        expect(world.names(DIRECTORY)).toEqual([FINAL_NAME]);
        expect(world.contents.get(FINAL)).toBe(CONTENT);
      });
    }
  }
});

describe('T3: a writer crashed after any step leaves at most one unit, and the next sweep removes it', () => {
  for (const form of FORMS) {
    for (const publish of MODES) {
      it(`${form} form, ${publish}: crash after each step (create, lock, write, before publish, after publish, release), then sweep`, async () => {
        const total = (await stepsOfCompleteWrite(form, publish)).length;
        expect(total).toBeGreaterThanOrEqual(5);
        for (let crashAt = 1; crashAt <= total; crashAt += 1) {
          const { world, writer } = freshWriter(form, { crashAt });
          await writeUntilCrash(writer, publish);
          expect(writer.isDead(), `crash at step ${crashAt}`).toBe(true);
          expect(unitsOf(world.names(DIRECTORY)).size, `units after a crash at step ${crashAt}: ${world.names(DIRECTORY).join(', ')}`).toBeLessThanOrEqual(1);
          await sweep(world);
          const left = world.names(DIRECTORY);
          expect(left.filter((name) => name !== FINAL_NAME), `left after the sweep, crash at step ${crashAt}`).toEqual([]);
          if (left.includes(FINAL_NAME)) expect(world.contents.get(FINAL)).toBe(CONTENT);
        }
      });

      it(`${form} form, ${publish}: two writers crashed at any steps leave at most two units, and one sweep removes both`, async () => {
        const total = (await stepsOfCompleteWrite(form, publish)).length;
        for (let crashAt = 1; crashAt <= total; crashAt += 1) {
          const world = createWorld(form, [DIRECTORY]);
          await writeUntilCrash(world.actor('first', { crashAt }), publish, 11);
          await writeUntilCrash(world.actor('second', { crashAt: total + 1 - crashAt }), publish, 13);
          expect(unitsOf(world.names(DIRECTORY)).size).toBeLessThanOrEqual(2);
          await sweep(world);
          expect(world.names(DIRECTORY).filter((name) => name !== FINAL_NAME)).toEqual([]);
        }
      });
    }
  }
});

describe('T3: a sweep during any step of a live writer never removes its entry, and its write completes', () => {
  for (const form of FORMS) {
    for (const publish of MODES) {
      it(`${form} form, ${publish}: the sweep runs while the writer is paused before each step`, async () => {
        const total = (await stepsOfCompleteWrite(form, publish)).length;
        for (let pauseAt = 1; pauseAt <= total; pauseAt += 1) {
          const { world, writer } = freshWriter(form, { pauseAt });
          const writing = write(writer, publish);
          await writer.paused.reached;
          await sweep(world);
          writer.paused.resume();
          await writing;
          expect(world.names(DIRECTORY), `paused before step ${pauseAt}`).toEqual([FINAL_NAME]);
          expect(world.contents.get(FINAL)).toBe(CONTENT);
        }
      });
    }
  }
});

describe('atomic-file.ts:51 today: a temporary left by a crash before publish is found by no sweep', () => {
  it('the registered sweep removes the temporary a crash before rename left behind', async () => {
    const world = createWorld('entry', [DIRECTORY]);
    const steps = await stepsOfCompleteWrite('entry', 'replace');
    const rename = steps.findIndex((step) => step.startsWith('rename '));
    expect(rename).toBeGreaterThan(0);
    const writer = world.actor('writer', { crashAt: rename + 1 });
    await writeUntilCrash(writer, 'replace');
    expect(world.names(DIRECTORY).length).toBe(1);
    await sweep(world);
    expect(world.names(DIRECTORY)).toEqual([]);
  });
});
