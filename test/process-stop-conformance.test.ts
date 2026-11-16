import { createTempDir, sleepDrivenTiming, SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAXIMUM_STOP_VALUES, createPosixGroupPort, signalGroupExceptLeader, gatewayStopBudgetMs, killedChildSettleMs, managedServerReapBoundMs, reapMarkedProcesses, reconcileProcessGroup, runtimeStopBudgetMs, supervisorMaxCloseMs } from '@momonga/foundation';
import type { ProcessGroupPort, ProcessInspector, Timing } from '@momonga/foundation';
import { readManifest } from './formal/manifest.ts';
import { cfgNames } from './formal/cfg-names.ts';
import { canStillRun } from '../packages/foundation/src/platform/run-state.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'ProcessStop.tla'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ProcessStop.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const variants = (): string[] => {
  const match = /ASSUME Variant \\in \{([^}]*)\}/.exec(spec);
  if (match === null) throw new Error('the Variant set is not declared in ProcessStop.tla');
  return (match[1] ?? '').split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
};

type Entry = { pgid: number; holdsMarker: boolean; startedAt: bigint; startUnreadable?: boolean };

type World = { signals: Array<{ target: number; signal: NodeJS.Signals }>; kill: (target: number, signal: NodeJS.Signals | 0) => void; inspector: ProcessInspector; groupPort: ProcessGroupPort };

const world = (initial: Record<number, Entry>, reuseAtGroupRead: Record<number, Record<number, Entry>>): World => {
  const table = new Map<number, Entry>(Object.entries(initial).map(([pid, entry]) => [Number(pid), entry]));
  const signals: World['signals'] = [];
  let groupReads = 0;
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    const hit = target < 0 ? [...table].filter(([, entry]) => entry.pgid === -target).map(([pid]) => pid) : table.has(target) ? [target] : [];
    if (signal !== 0) signals.push({ target, signal });
    if (hit.length === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };
  const inspector = {
    startTimeOf: async (pid: number) => {
      const entry = table.get(pid);
      if (entry === undefined) return { kind: 'gone' };
      if (entry.startUnreadable === true) return { kind: 'failed', cause: 'deterministic', evidence: { kind: 'exit', exitCode: 1, detail: 'ps exited with 1' } };
      return { kind: 'value', value: entry.startedAt };
    },
    holdersOf: async () => ({ kind: 'value', value: [...table].filter(([, entry]) => entry.holdsMarker).map(([pid]) => pid) }),
    groupsOf: async (pids: readonly number[]) => {
      groupReads += 1;
      const rows = new Map(pids.filter((pid) => table.has(pid)).map((pid) => [pid, table.get(pid)!.pgid]));
      for (const [pid, entry] of Object.entries(reuseAtGroupRead[groupReads] ?? {})) table.set(Number(pid), entry);
      return { kind: 'value', value: rows };
    },
    markerState: async () => 'free',
  } as unknown as ProcessInspector;
  const groupPort = createPosixGroupPort({
    kill,
    reading: { states: async (pgid) => [...table.values()].filter((entry) => entry.pgid === pgid).map(() => 'S'), successMeansRunnable: false },
  });
  return { signals, kill, inspector, groupPort };
};

const instantTiming = (): Timing => {
  let now = 0;
  return sleepDrivenTiming({
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  }) as Timing;
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markerFile = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

const reconcile = async (scene: World) => reconcileProcessGroup({ pgid: 100, marker: markerFile() }, { killGraceMs: 1000, kill: scene.kill, groupPort: scene.groupPort, timing: instantTiming(), inspector: scene.inspector });

const stranger = (pgid: number): Entry => ({ pgid, holdsMarker: false, startedAt: 999_999n });

describe('the reap signals only a target proved ours by the same start time at the listing and just before the signal, as specs/tla/ProcessStop.tla states', () => {
  it('the model proves a holder target only while its pid is not reused, and proves the group only by a listed holder in it that is not gone', () => {
    expect(definitionOf('HolderTargetProved')).toContain('~swapped[m]');
    expect(definitionOf('ListedHolderInGroup')).toContain('state[m] # "gone"');
    expect(definitionOf('ListedHolderInGroup')).not.toContain('swapped');
  });

  it.each(['signalUnprovedHolder', 'killWithoutReproof', 'groupProofWithoutStartTime'])('the code without the check, variant %s, is an evidence configuration that violates NoSignalToUnprovedGroup', (variant) => {
    expect(variants()).toContain(variant);
    expect(manifest.entries.find((entry) => entry.config === `ProcessStop.${variant}`)).toMatchObject({ role: 'evidence', expect: { violates: 'NoSignalToUnprovedGroup' } });
  });

  it('the same-second reuse of a pid by another generation is modelled, so the darwin one-second start time is the limit the proof must not rely on alone', () => {
    const darwin = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'foundation', 'src', 'platform', 'darwin-inspector.ts'), 'utf8');
    expect(darwin).toContain("'lstart='");
    expect(definitionOf('ReuseSameSecond')).toContain('SameSecondReuse');
    expect(definitionOf('HolderTargetProved')).toContain('crossGen');
  });

  it('the stop proves a target and signals it in one step: Begin signals through SigT, which needs the proof of the target', () => {
    expect(definitionOf('Begin')).toContain('SigT(m)');
    expect(definitionOf('SigT')).toContain('TermAllowed(m)');
  });

  it.each(['retireSignalsOther', 'crossGenWithoutHold'])('the code variant %s is an evidence configuration that violates StopNeverSignalsOtherGen', (variant) => {
    expect(variants()).toContain(variant);
    expect(manifest.entries.find((entry) => entry.config === `ProcessStop.${variant}`)).toMatchObject({ role: 'evidence', expect: { violates: 'StopNeverSignalsOtherGen', exitCode: 13 } });
  });

  it('the proof of a target requires the marker hold at the reprove, and a stop of a holder that stopped holding is not proved', () => {
    expect(definitionOf('HolderTargetProved')).toContain('held[m]');
    expect(definitionOf('Unhold')).toContain('held[m]');
    expect(definitionOf('ReusePid')).toContain("held' = [held EXCEPT ![m] = FALSE]");
  });

  it('a same-second reuse without the hold is an evidence configuration that violates NoSignalToNonHolder', () => {
    expect(variants()).toContain('sameSecondWithoutHold');
    expect(manifest.entries.find((entry) => entry.config === 'ProcessStop.sameSecondWithoutHold')).toMatchObject({ role: 'evidence', expect: { violates: 'NoSignalToNonHolder', exitCode: 13 } });
  });

  it('a group is proved only by a listed holder that is now a member of the group and still holds the marker', () => {
    expect(definitionOf('ListedHolderInGroup')).toContain('inGroup[m]');
    expect(definitionOf('ListedHolderInGroup')).toContain('held[m]');
    expect(definitionOf('LeaveGroup')).toContain("inGroup' = [inGroup EXCEPT ![m] = FALSE]");
    expect(variants()).toContain('groupProofIgnoresGroup');
    expect(manifest.entries.find((entry) => entry.config === 'ProcessStop.groupProofIgnoresGroup')).toMatchObject({ role: 'evidence', expect: { violates: 'NoSignalToUnprovedGroup', exitCode: 12 } });
  });

  it('every listing is the processes that hold the marker now, and the words gone, terminated and killed need a fresh listing', () => {
    expect(definitionOf('FreshListing')).toContain('held[m]');
    for (const step of ['Begin', 'TermWaitEnds', 'KillWaitEnds', 'Sweep']) expect(definitionOf(step)).toContain('ListFresh');
    expect(definitionOf('Fork')).toContain('IF Escape THEN FALSE');
    expect(variants()).toContain('noRelist');
    expect(manifest.entries.find((entry) => entry.config === 'ProcessStop.noRelist')).toMatchObject({ role: 'evidence', expect: { violates: 'FinishSeesEveryHolder', exitCode: 13 } });
  });

  it.each(['ProcessStop.escape', 'ProcessStop.escapeGenerations'])('the configuration %s, with groups left and listings renewed, holds', (config) => {
    expect(manifest.entries.find((entry) => entry.config === config)).toMatchObject({ role: 'check', expect: 'holds' });
  });

  it('GroupFollowers: on every world of the model, with each follower staying, exiting, or exiting and its pid reused between the listing and the send, the teardown signals exactly the followers still proved and never a stranger', () => {
    const followers = cfgNames(specDir, 'GroupFollowers');
    expect(followers.invariants).toContain('NoStrangerSignalled');
    const members = (followers.constants['Members'] ?? '').replace(/[{}]/g, '').split(',').map((name) => name.trim());
    const leader = 500;
    const pidOf = (index: number): number => leader + 1 + index;
    type Fate = 'gone' | 'stays' | 'exits' | 'reused';
    let worlds: Fate[][] = [[]];
    for (const _member of members) worlds = worlds.flatMap((world) => (['gone', 'stays', 'exits', 'reused'] as const).map((fate) => [...world, fate]));
    const failures: string[] = [];
    for (const fates of worlds) {
      const sent: number[] = [];
      const atList = fates.flatMap((fate, index) => (fate === 'gone' ? [] : [{ pid: pidOf(index), startTicks: 10n + BigInt(index) }]));
      const atSend = (pid: number) => {
        const fate = fates[pid - leader - 1];
        if (fate === 'stays') return { groupId: leader, startTicks: 10n + BigInt(pid - leader - 1) };
        if (fate === 'reused') return { groupId: 900, startTicks: 99n };
        return undefined;
      };
      const signalled = signalGroupExceptLeader(leader, 'SIGTERM', { members: () => [{ pid: leader, startTicks: 1n }, ...atList], statOf: atSend }, (pid) => {
        sent.push(pid);
        if (atSend(pid) === undefined) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      const proved = fates.flatMap((fate, index) => (fate === 'stays' ? [pidOf(index)] : []));
      if (JSON.stringify(sent) !== JSON.stringify(proved) || signalled !== proved.length) failures.push(`${fates.join(',')}: sent ${sent.join(',')}`);
    }
    expect(failures).toEqual([]);
  });

  it.each(['ProcessStop.generations', 'ProcessStop.userStop'])('the generation configuration %s holds', (config) => {
    expect(manifest.entries.find((entry) => entry.config === config)).toMatchObject({ role: 'check', expect: 'holds' });
  });

  it('signalUnprovedHolder: a holder whose pid is reused before the SIGTERM is not signalled', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startedAt: 1n }, 200: { pgid: 200, holdsMarker: true, startedAt: 2n } }, { 1: { 200: stranger(300) } });
    await reconcile(scene);
    expect(scene.signals.filter(({ target }) => target === 200)).toEqual([]);
  });

  it('killWithoutReproof: a holder whose pid is reused after the SIGTERM pass is not sent SIGKILL', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startedAt: 1n }, 200: { pgid: 200, holdsMarker: true, startedAt: 2n } }, { 3: { 200: stranger(300) } });
    await reconcile(scene);
    expect(scene.signals.filter(({ target }) => target === 200)).toEqual([{ target: 200, signal: 'SIGTERM' }]);
  });

  it('groupProofWithoutStartTime: a group whose only listed holder is replaced by a process of a reused group is not signalled', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startedAt: 1n } }, { 1: { 100: stranger(100) } });
    await reconcile(scene);
    expect(scene.signals).toEqual([]);
  });

  it('a target whose start time cannot be read is never proved, on either reap path, and is reported left alone', async () => {
    const recorded = world({ 100: { pgid: 100, holdsMarker: true, startedAt: 1n, startUnreadable: true }, 200: { pgid: 200, holdsMarker: true, startedAt: 2n, startUnreadable: true } }, {});
    const result = await reconcile(recorded);
    expect(recorded.signals).toEqual([]);
    expect([...result.leftAlonePids].sort()).toEqual([100, 200]);
    const unrecorded = world({ 200: { pgid: 200, holdsMarker: true, startedAt: 2n, startUnreadable: true } }, {});
    const warnings: string[] = [];
    await reapMarkedProcesses({ marker: markerFile(), killGraceMs: 1000, label: 'tool', onWarning: (message) => warnings.push(message), kill: unrecorded.kill, groupPort: unrecorded.groupPort, timing: instantTiming(), inspector: unrecorded.inspector });
    expect(unrecorded.signals).toEqual([]);
    expect(warnings.some((warning) => warning.includes('process 200 is still alive but could not be verified as belonging to this call'))).toBe(true);
  });
});

describe('a stop whose listing fails ends with the outcome unlisted, as specs/tla/ProcessStop.tla states', () => {
  it('the model has the outcome unlisted, reached only by ListFails, and states it in two properties', () => {
    expect(definitionOf('ListFails')).toContain('Finish("unlisted", KeepOnUnconfirmed)');
    expect(definitionOf('ListFailureSaysUnlisted')).toContain('ListFails => outcome\' = "unlisted"');
    expect(definitionOf('NoWordFromFailedListing')).toContain('ListFails => outcome\' \\notin {"gone", "terminated", "killed"}');
    expect(variants()).toEqual(expect.arrayContaining(['listFailAsUnconfirmed', 'listFailAsEmpty']));
  });

  it('the code, like the model, ends a stop whose first listing fails with the whole could-not-check text, says no stop word as an outcome, signals nothing and keeps the marker', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startedAt: 1n } }, {});
    const failing = { ...scene.inspector, holdersOf: async () => ({ kind: 'failed', cause: 'transient', evidence: { kind: 'timeout', detail: 'the listing was slow' } }) } as unknown as ProcessInspector;
    const marker = markerFile();
    const result = await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: scene.kill, groupPort: scene.groupPort, timing: instantTiming(), inspector: failing });
    expect(result.output).toBe(
      `MomongaCode could not check whether a process started by the interrupted command is still running (listing the holders of ${marker} failed (transient): the listing was slow). Nothing was stopped. The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
    );
    expect(result.outcome).toBe('unknown');
    expect(['gone', 'terminated', 'killed', 'stopped']).not.toContain(result.outcome);
    expect(result.stopped).toBe(false);
    expect(result.stoppedHolders).toEqual([]);
    expect(result.output).not.toMatch(/no longer running|The interrupted command was stopped|Still running but/);
    expect(scene.signals).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('the settle says that a process is still running only while a holder or a member of its group can still run, as specs/tla/ProcessStop.tla states', () => {
  it.each(['settleCandidate', 'settleCurrent', 'guardCurrent', 'guardUnknownCurrent', 'guardHeldCurrent', 'jobCurrent', 'reconcileCurrent'])('the variant %s is declared in the model', (variant) => {
    expect(variants()).toContain(variant);
  });

  it('a holder is a member that is live, stuck or exiting, so a zombie or a gone member holds nothing', () => {
    expect(definitionOf('Holding')).toContain('"exiting"');
    expect(definitionOf('Holding')).not.toContain('zombie');
  });

  it("the model's CanStillRun is the code's canStillRun: live and stuck run, and an exiting member or a zombie does not", () => {
    expect(definitionOf('CanStillRun')).toContain('state[m] \\in {"live", "stuck"}');
    expect(canStillRun('S')).toBe(true);
    expect(canStillRun('SE')).toBe(false);
    expect(canStillRun('Z')).toBe(false);
  });

  it('a claim that a process is still running carries the basis of positive evidence', () => {
    expect(definitionOf('Claimed')).toContain("basis' = Pos");
    expect(spec).toContain('RefuseOnlyOnPositiveEvidence == shown \\in {"running", "guard"} => basis');
    expect(spec).toContain('FinalNoticeOnlyWhenHeldOrPositive == shown = "final" => basis');
  });

  it.each([
    ['settleCurrent', 'RefuseOnlyOnPositiveEvidence'],
    ['guardCurrent', 'RefuseOnlyOnPositiveEvidence'],
    ['guardUnknownCurrent', 'RefuseOnlyOnPositiveEvidence'],
    ['guardHeldCurrent', 'RefuseOnlyOnPositiveEvidence'],
    ['jobCurrent', 'RemovalSafe'],
  ])('the code without the check, variant %s, is an evidence configuration that violates %s', (variant, property) => {
    expect(manifest.entries.find((entry) => entry.config === `ProcessStop.${variant}`)).toMatchObject({ role: 'evidence', expect: { violates: property, exitCode: 12 } });
  });

  it.each([
    ['ProcessStop.reconcileCurrent', 'NoLongerRunningOnlyWhenClear'],
    ['ProcessStop.listFailCurrent', 'NoRunningClaimAfterListFailure'],
  ])('the code without the check, %s, is an evidence configuration that violates %s', (config, property) => {
    expect(manifest.entries.find((entry) => entry.config === config)).toMatchObject({ role: 'evidence', expect: { violates: property, exitCode: 12 } });
  });

  it('a list failure claims nothing running, and the reconcile claims no longer running only when nothing holds the marker or can run', () => {
    expect(definitionOf('NoRunningClaimAfterListFailure')).toContain('listFailed => shown # "running"');
    expect(definitionOf('NoLongerRunningOnlyWhenClear')).toContain('shown = "gone" => basis');
    expect(definitionOf('ReconcileCall')).toContain('ObsHeld');
  });

  it('a refusal, a running claim and the final notice rest on positive evidence: a named holder, a runnable group member, or the marker still held after the four occasions', () => {
    expect(definitionOf('Pos')).toContain('groupKnown');
    expect(definitionOf('RefusalDue')).toContain('Pos');
    expect(definitionOf('RefusalDue')).toContain('AllEventsSpent');
    expect(definitionOf('FinalNotice')).toContain('ObsHeld');
    expect(definitionOf('SurvivorReachesNotice')).toContain('SomeoneRuns');
  });

  it('the candidate configuration is a check that holds', () => {
    expect(manifest.entries.find((entry) => entry.config === 'ProcessStop.settleCandidate')).toMatchObject({ role: 'check', expect: 'holds' });
  });
});

describe('every child a stop kills has a bound that holds its own kill confirmation, as specs/tla/StopProtocol.tla RT and CHILD state', () => {
  const stopProtocol = fs.readFileSync(path.join(specDir, 'StopProtocol.tla'), 'utf8');

  it('the supervisor close holds the runtime stop budget and the settle of a killed runtime before the gateway term, and the evidence without that share violates NoManagedOutlives', () => {
    expect(stopProtocol).toMatch(/^RT\(r\) == r \+ KILLCONF \+ 1$/m);
    expect(stopProtocol).toMatch(/^CHILD\(v\) == GW\(v\) \+ KILLCONF \+ 1$/m);
    const evidence = manifest.entries.find((entry) => entry.config === 'StopProtocol.runtimeNoShare');
    expect(evidence?.expect).toEqual({ violates: 'NoManagedOutlives', exitCode: 12 });
    for (const values of [MAXIMUM_STOP_VALUES, { closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 0 }]) {
      const withShares = runtimeStopBudgetMs(values) + killedChildSettleMs() + gatewayStopBudgetMs(values) + killedChildSettleMs() + managedServerReapBoundMs(values);
      expect(supervisorMaxCloseMs(values), JSON.stringify(values)).toBeGreaterThanOrEqual(withShares);
    }
  });
});
