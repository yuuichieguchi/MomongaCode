import { describe, expect, it } from 'vitest';
import { KEEPER_JOB_PREFIX } from '../../src/process-contract.ts';
import { createProcessGroupPort } from '../../src/platform/group-port.ts';
import type { ProcessGroupPort } from '../../src/platform/group-port.ts';
import { GroupContainmentError, createKeptGroupControl } from '../../src/platform/windows-kept-groups.ts';
import type { KeptGroupControl } from '../../src/platform/windows-kept-groups.ts';
import { nodeCommandRunner } from '../../src/platform/command-runner.ts';
import { answeringMembers, fakeKeeperHost, settle } from '../support/fake-keeper.ts';
import type { FakeKeeper, FakeKeeperHost } from '../support/fake-keeper.ts';
import { pendingOrSettled } from '../support/probe-fakes.ts';

const KEEPER_PID = 4100;
const COMMAND_PID = 4242;
const NAME = 'ab'.repeat(16);
const LIVE = { signal: new AbortController().signal };

const portOf = (kept: KeptGroupControl): ProcessGroupPort => createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept });

const opened = (fake: FakeKeeperHost, kept: KeptGroupControl, marker?: string) =>
  kept.open({ command: { file: 'cmd.exe', args: ['/c', 'echo'] }, marker, start: (executable, args) => ({ ...fake.start(executable, args), pid: KEEPER_PID }) });

const launchThen =
  (members: () => readonly number[], rest: (keeper: FakeKeeper, index: number) => void = () => undefined) =>
  (keeper: FakeKeeper, index: number): void => {
    if (keeper.mode !== 'launch') {
      rest(keeper, index);
      return;
    }
    answeringMembers(members)(keeper);
    keeper.say(`started ${COMMAND_PID}\n`);
  };

describe('the port of a job reports what it is as data', () => {
  it('a job has one signal and its identity is the job; a POSIX group has SIGTERM then SIGKILL and its identity is a listed holder', () => {
    const job = portOf(createKeptGroupControl(fakeKeeperHost().host));
    expect(job.signals).toEqual(['SIGTERM']);
    expect(job.identity).toBe('job');
    expect(job.keeper).toBeDefined();
    expect(job.names).toBeDefined();
    const posix = createProcessGroupPort('darwin', { run: nodeCommandRunner, env: {} });
    expect(posix.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(posix.identity).toBe('holder');
    expect(posix.keeper).toBeUndefined();
    expect(posix.names).toBeUndefined();
  });

  it('is not built without the keeper client', () => {
    expect(() => createProcessGroupPort('win32', { run: nodeCommandRunner, env: {} })).toThrow(/keeper/);
  });
});

describe('a group launched through the keeper is the group of the keeper pid', () => {
  it('starts the keeper in launch mode, owner loss terminate, the marker by its path, and names the group by 128 random bits', async () => {
    const fake = fakeKeeperHost(launchThen(() => [COMMAND_PID]));
    const kept = createKeptGroupControl(fake.host);
    opened(fake, kept, 'C:\\m\\marker');
    await settle();
    const args = fake.keepers[0]?.args ?? [];
    expect(args[0]).toBe('launch');
    expect(args[2]).toMatch(/^Local\\momonga-[0-9a-f]{32}$/);
    expect(args[3]).toBe('terminate');
    expect(args[4]).toBe(Buffer.from('C:\\m\\marker', 'utf8').toString('hex'));
    expect(args.slice(5)).toEqual(['--', 'cmd.exe', '/c', 'echo']);
    expect(`${KEEPER_JOB_PREFIX}${kept.nameOf(KEEPER_PID)}`).toBe(args[2]);
  });

  it('is alive while the keeper lists a member, and its liveness is the answer of the keeper, with no other process started', async () => {
    let members = [COMMAND_PID, 4300];
    const fake = fakeKeeperHost(launchThen(() => members));
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(true);
    members = [];
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(false);
    expect(fake.keepers).toHaveLength(1);
  });

  it('gives the exit code of the command from the exit word, and lost when the pipe closes without one', async () => {
    const fake = fakeKeeperHost(launchThen(() => []));
    const kept = createKeptGroupControl(fake.host);
    const first = opened(fake, kept);
    await settle();
    fake.keepers[0]?.say('exit 3\n');
    expect(await first.commandExit).toEqual({ kind: 'exit', code: 3 });
    const second = opened(fake, kept);
    await settle();
    fake.keepers[1]?.hangUp();
    expect(await second.commandExit).toEqual({ kind: 'lost' });
  });

  it('is gone after the empty word without asking by name', async () => {
    const fake = fakeKeeperHost(launchThen(() => [COMMAND_PID]));
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    await settle();
    fake.keepers[0]?.say('exit 0\nempty\n');
    fake.keepers[0]?.hangUp();
    await settle();
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(false);
    await port.signal(KEEPER_PID, 'SIGTERM', LIVE);
    expect(fake.keepers).toHaveLength(1);
    expect(fake.keepers[0]?.written.filter((line) => line === 'terminate\n')).toEqual([]);
  });

  it('a pipe that closed without the empty word is read by the name: gone when the name no longer opens, alive while it opens with members', async () => {
    let present = true;
    const fake = fakeKeeperHost(
      launchThen(
        () => [COMMAND_PID],
        (keeper) => {
          if (!present) {
            keeper.say('failed job-absent 2\n');
            return;
          }
          answeringMembers(() => [COMMAND_PID])(keeper);
          keeper.say('attached\n');
        },
      ),
    );
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    await settle();
    fake.keepers[0]?.hangUp();
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(true);
    expect(fake.keepers[1]?.args.slice(0, 3)).toEqual(['attach', fake.listened[1], fake.keepers[0]?.job]);
    expect(fake.keepers[1]?.closedByClient()).toBe(true);
    present = false;
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(false);
    const asked = fake.keepers.length;
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(false);
    expect(fake.keepers).toHaveLength(asked);
  });

  it('sends one terminate word for a signal of any name', async () => {
    const fake = fakeKeeperHost(launchThen(() => [COMMAND_PID]));
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    await port.signal(KEEPER_PID, 'SIGTERM', LIVE);
    expect(fake.keepers[0]?.written.filter((line) => line === 'terminate\n')).toHaveLength(1);
  });

  it('resolves ended when the keeper says empty, with no question in between', async () => {
    const fake = fakeKeeperHost(launchThen(() => [COMMAND_PID]));
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    await settle();
    const ended = (port.ended as NonNullable<ProcessGroupPort['ended']>)(KEEPER_PID, LIVE);
    expect((await pendingOrSettled(ended)).state).toBe('pending');
    const asked = fake.keepers[0]?.written.length;
    fake.keepers[0]?.say('exit 0\nempty\n');
    await ended;
    expect(fake.keepers[0]?.written.length).toBe(asked);
  });

  it('a question on a pipe that never answers ends with the signal of the asker', async () => {
    const fake = fakeKeeperHost((keeper) => keeper.say(`started ${COMMAND_PID}\n`));
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    const controller = new AbortController();
    const asked = port.alive(KEEPER_PID, { signal: controller.signal });
    await settle();
    expect((await pendingOrSettled(asked)).state).toBe('pending');
    controller.abort(new Error('the deadline passed'));
    await expect(asked).rejects.toThrow('the deadline passed');
  });
});

describe('T-JO-7 on a fake keeper: a refused containment is reported and nothing is called contained', () => {
  it('rejects the exit of the command with the reason of the keeper, and the group is gone without the name being opened', async () => {
    const fake = fakeKeeperHost((keeper) => keeper.say('failed containment-unavailable 5\n'));
    const port = portOf(createKeptGroupControl(fake.host));
    const opening = opened(fake, port.keeper as KeptGroupControl);
    const refusal = await opening.commandExit.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(GroupContainmentError);
    expect(refusal).toMatchObject({ reason: 'containment-unavailable', systemError: 5 });
    expect((refusal as Error).message).toContain('containment-unavailable');
    expect((refusal as Error).message).toContain('was not started');
    expect(await port.alive(KEEPER_PID, LIVE)).toBe(false);
    expect(fake.keepers).toHaveLength(1);
  });

  it('a taken name is refused the same way and the job of that name is never terminated', async () => {
    const fake = fakeKeeperHost((keeper) => keeper.say('failed name-taken 183\n'));
    const port = portOf(createKeptGroupControl(fake.host));
    const opening = opened(fake, port.keeper as KeptGroupControl);
    await expect(opening.commandExit).rejects.toMatchObject({ reason: 'name-taken' });
    await port.signal(KEEPER_PID, 'SIGTERM', LIVE);
    expect(fake.keepers).toHaveLength(1);
  });
});

describe('a group read back from a record is proved by its name', () => {
  it('attaches by Local\\momonga-<name>: alive while the name opens with members, gone when it does not open', async () => {
    let present = true;
    const fake = fakeKeeperHost((keeper) => {
      if (!present) {
        keeper.say('failed job-absent 2\n');
        return;
      }
      answeringMembers(() => [77])(keeper);
      keeper.say('attached\n');
    });
    const port = portOf(createKeptGroupControl(fake.host));
    port.names?.recall(5000, NAME);
    expect(port.names?.nameOf(5000)).toBe(NAME);
    expect(await port.alive(5000, LIVE)).toBe(true);
    expect(fake.keepers[0]?.args).toEqual(['attach', fake.listened[0], `${KEEPER_JOB_PREFIX}${NAME}`]);
    present = false;
    expect(await port.alive(5000, LIVE)).toBe(false);
  });

  it('terminates through the attached keeper and waits for its empty word before it lets the keeper go', async () => {
    const fake = fakeKeeperHost((keeper) => {
      answeringMembers(() => [77])(keeper);
      keeper.say('attached\n');
    });
    const port = portOf(createKeptGroupControl(fake.host));
    port.names?.recall(5000, NAME);
    const sent = port.signal(5000, 'SIGTERM', LIVE);
    await settle();
    expect(fake.keepers[0]?.written).toContain('terminate\n');
    expect((await pendingOrSettled(sent)).state).toBe('pending');
    expect(fake.keepers[0]?.closedByClient()).toBe(false);
    fake.keepers[0]?.say('empty\n');
    await sent;
    expect(fake.keepers[0]?.closedByClient()).toBe(true);
  });

  it('does not answer for a group that has no job on record', async () => {
    const port = portOf(createKeptGroupControl(fakeKeeperHost().host));
    await expect(port.alive(6000, LIVE)).rejects.toThrow(/no job/);
    await expect(port.signal(6000, 'SIGTERM', LIVE)).rejects.toThrow(/no job/);
  });

  it('a record never replaces a group this process launched under the same number', async () => {
    const fake = fakeKeeperHost(launchThen(() => [COMMAND_PID]));
    const port = portOf(createKeptGroupControl(fake.host));
    opened(fake, port.keeper as KeptGroupControl);
    await settle();
    const launchedName = port.names?.nameOf(KEEPER_PID);
    port.names?.recall(KEEPER_PID, NAME);
    expect(port.names?.nameOf(KEEPER_PID)).toBe(launchedName);
  });
});
