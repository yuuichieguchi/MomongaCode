import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_RETIRED, fixedRolePort, roleOfGeneration } from '@momonga/foundation';
import { JOB_STATUSES } from '@momonga/protocol';
import { EVERY_ROLE_LOOP_NAMES, SERVING_LOOP_NAMES, SERVING_TASK_NAMES } from '../packages/runtime/src/process/serving-tasks.ts';
import { readManifest } from './formal/manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'UpdateSwitch.tla'), 'utf8');
const recovery = fs.readFileSync(path.join(specDir, 'RunRecovery.tla'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));
const toolsSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'tools', 'src', 'executor.ts'), 'utf8');
const runtimeToolsSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'runtime', 'src', 'process', 'tool-runtime.ts'), 'utf8');

const configNames = manifest.entries.map((entry) => entry.config);

describe('the runtime across generations and the UpdateSwitch model (17.8, 20.99)', () => {
  it('the three roles of the model are the roles of the one role source', () => {
    expect([roleOfGeneration(2, undefined), roleOfGeneration(2, 2), roleOfGeneration(2, 3)]).toEqual(['starting', 'serving', 'retiring']);
    expect(roleOfGeneration(2, 1)).toBe('starting');
    expect(fixedRolePort('retiring').current()).toBe('retiring');
  });

  it('the serving-only work of the code is data, and no every-role loop is in it (SweepServingOnly)', () => {
    expect(spec).toMatch(/^SweepServingOnly == /m);
    const servingOnly: readonly string[] = [...SERVING_TASK_NAMES, ...SERVING_LOOP_NAMES];
    expect(new Set(servingOnly).size).toBe(servingOnly.length);
    for (const name of EVERY_ROLE_LOOP_NAMES) expect(servingOnly).not.toContain(name);
    expect(servingOnly).toEqual(expect.arrayContaining(['approval-sweeper', 'terminal-sweeper', 'search-sweeper', 'memory-sweeper', 'facts-sweeper', 'idempotency-purge', 'session-scratch', 'tool-markers', 'fidelity-prune']));
  });

  it('the job statuses of the store hold the two the model folds into killed', () => {
    expect(JOB_STATUSES).toEqual(expect.arrayContaining(['running', 'exited', 'killed', 'unknown']));
  });

  it.each([
    ['NoNewJobWhileRetiring', 'UpdateSwitch.jobRetiring'],
    ['ReconcileOwnerDead', 'UpdateSwitch.reconcileLive'],
    ['PruneBelowLive', 'UpdateSwitch.pruneAll'],
    ['KillReachesOwner', 'UpdateSwitch.killDropped'],
    ['OutputReadableAnyGen', 'UpdateSwitch.readOwnGenOnly'],
    ['NoKillByUpdate', 'UpdateSwitch.killWithoutRequest'],
    ['SweepServingOnly', 'UpdateSwitch.sweepRetiring'],
  ])('%s is defined in the model and has the evidence configuration %s in the manifest', (property, evidence) => {
    expect(spec).toMatch(new RegExp(`^${property} == `, 'm'));
    expect(configNames).toContain(evidence);
  });

  it('a retired runtime exits with the code the supervisor classifies as retired', () => {
    expect(EXIT_RETIRED).toBe(79);
  });

  it('the call lock is one shared lock over the workers of every generation, and the earlier marker is looked up across generations after it is held (RunRecovery Held(k), 20.35)', () => {
    expect(recovery).toMatch(/^Held\(k\) == \\E x \\in Workers : wlock\[x\] \/\\ KeyOf\(x\) = k$/m);
    expect(runtimeToolsSource).toContain('callLockDir: paths.callLocks');
    expect(runtimeToolsSource).toContain('earlierMarkerDirs');
    const hold = toolsSource.indexOf("if ((await scope.holdCall()) === 'aborted') return { kind: 'outcome'");
    const reap = toolsSource.indexOf('const earlierAttempt = await reapEarlierAttempt(record.key, record, scope.controller.signal);');
    expect(hold).toBeGreaterThan(-1);
    expect(reap).toBeGreaterThan(hold);
  });
});
