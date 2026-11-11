import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { PermissionSubject } from '@momonga/policy';
import type { CallOutcome, ObservedFile, WorkTreeMark, WorkTreeObserver } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const COMMAND_SCHEMA = { type: 'object', properties: { command: { type: 'string' }, file: { type: 'string' } }, required: ['command'], additionalProperties: false } as const;
const PATH_SCHEMA = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } as const;

type Scripted = ObservedFile[] | undefined;

const scriptedObserver = (script: Scripted[]) => {
  const counts = { mark: 0, changedSince: 0 };
  let next = 0;
  const observer: WorkTreeObserver = {
    mark: async () => {
      counts.mark += 1;
      next += 1;
      return { id: `m${next}` } as unknown as WorkTreeMark;
    },
    changedSince: async () => {
      const files = script[counts.changedSince];
      counts.changedSince += 1;
      next += 1;
      return files === undefined ? undefined : { files, mark: { id: `m${next}` } as unknown as WorkTreeMark };
    },
  };
  return { observer, counts, trees: () => counts.mark + counts.changedSince };
};

const sh = (written: string[]) =>
  makeTool('Sh', {
    sideEffect: 'exec',
    subjectKind: 'command',
    kind: 'execute',
    inputSchema: COMMAND_SCHEMA,
    subject: (input) => ({ kind: 'command', tool: 'Sh', command: String(input['command']) }),
    execute: async (input) => {
      if (typeof input['file'] === 'string') {
        fs.writeFileSync(input['file'], String(input['command']));
        written.push(input['file']);
      }
      return { status: 'completed', output: 'ran', exitCode: 0 };
    },
  });

const write = () =>
  makeTool('Write', {
    sideEffect: 'write',
    subjectKind: 'path',
    kind: 'edit',
    inputSchema: PATH_SCHEMA,
    subject: (input): Extract<PermissionSubject, { kind: 'path' }> => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' }),
    execute: async (input) => {
      fs.writeFileSync(String(input['file_path']), 'own');
      return { status: 'completed', output: 'written', files: [{ path: String(input['file_path']), sha256: sha256Hex('own'), access: 'write' }] };
    },
  });

const read = () => makeTool('Read', { execute: async () => ({ status: 'completed', output: 'read' }) });

const resultOf = (outcome: CallOutcome | undefined) => {
  if (outcome?.kind !== 'result') throw new Error(`expected a result, got ${outcome?.kind}`);
  return outcome.result as typeof outcome.result & { command?: string; windowShared?: true };
};

const setup = (script: Scripted[]) => {
  const scripted = scriptedObserver(script);
  const harness = makeHarness({ executor: { workTreeObserver: scripted.observer } as never });
  return { ...scripted, harness };
};

describe('the executor observes the work tree around a non-read-only call that declares no paths', () => {
  it('gives a call of a tool named Sh the observed files with the SHA-256 of their new content and its command', async () => {
    const written: string[] = [];
    const script: Scripted[] = [];
    const { harness, counts } = setup(script);
    const file = path.join(harness.layout.project, 'out.txt');
    script.push([{ path: file, change: 'write' }]);
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(sh(written)), [call('c1', 'Sh', { command: 'make fmt', file }, 'allow_once')]));
    const result = resultOf(outcome);
    expect(written).toEqual([file]);
    expect(result.files).toEqual([{ path: file, sha256: sha256Hex('make fmt'), access: 'write' }]);
    expect(result.command).toBe('make fmt');
    expect(counts).toEqual({ mark: 1, changedSince: 1 });
  });

  it('reports a removed file with no hash', async () => {
    const script: Scripted[] = [];
    const { harness } = setup(script);
    const gone = path.join(harness.layout.project, 'gone.txt');
    script.push([{ path: gone, change: 'remove' }]);
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(sh([])), [call('c1', 'Sh', { command: 'rm gone.txt' }, 'allow_once')]));
    expect(resultOf(outcome).files).toEqual([{ path: gone, access: 'remove' }]);
  });

  it('sets files to [] when the observer saw no change', async () => {
    const { harness, counts } = setup([[]]);
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(sh([])), [call('c1', 'Sh', { command: 'true' }, 'allow_once')]));
    expect(resultOf(outcome).files).toEqual([]);
    expect(counts.changedSince).toBe(1);
  });

  it('leaves files absent when the observer returns undefined', async () => {
    const { harness, counts } = setup([undefined]);
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(sh([])), [call('c1', 'Sh', { command: 'true' }, 'allow_once')]));
    expect(counts.mark).toBe(1);
    expect(resultOf(outcome)).not.toHaveProperty('files');
  });

  it('never observes a read-only call', async () => {
    const { harness, trees } = setup([]);
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(read()), [call('r1', 'Read')]));
    expect(resultOf(outcome)).not.toHaveProperty('files');
    expect(trees()).toBe(0);
  });

  it('never observes a call whose subject names the paths it writes, which keeps its own files', async () => {
    const { harness, trees } = setup([]);
    const file = path.join(harness.layout.project, 'w.txt');
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(write()), [call('w1', 'Write', { file_path: file }, 'allow_once')]));
    expect(resultOf(outcome).files).toEqual([{ path: file, sha256: sha256Hex('own'), access: 'write' }]);
    expect(trees()).toBe(0);
  });
});

describe('marks per batch are counted, never timed', () => {
  it('takes observed calls plus one marks when nothing else wrote between them', async () => {
    const { harness, trees, counts } = setup([[], [], []]);
    const calls = ['c1', 'c2', 'c3'].map((id) => call(id, 'Sh', { command: `step ${id}` }, 'allow_once'));
    await harness.executor.runBatch(await harness.input(await toolSetOf(sh([]), read()), [calls[0]!, call('r1', 'Read'), calls[1]!, calls[2]!]));
    expect(counts.changedSince).toBe(3);
    expect(trees()).toBe(4);
  });

  it('takes two marks per observed call when a Write ran between them', async () => {
    const { harness, trees, counts } = setup([[], []]);
    const file = path.join(harness.layout.project, 'between.txt');
    await harness.executor.runBatch(
      await harness.input(await toolSetOf(sh([]), write()), [
        call('c1', 'Sh', { command: 'one' }, 'allow_once'),
        call('w1', 'Write', { file_path: file }, 'allow_once'),
        call('c2', 'Sh', { command: 'two' }, 'allow_once'),
      ]),
    );
    expect(counts.changedSince).toBe(2);
    expect(trees()).toBe(4);
  });
});

describe('a window shared with a background job or a child run', () => {
  it('sets windowShared when the predicate is true at the end of the window', async () => {
    const answers = [false, true];
    const { harness } = setup([[]]);
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(sh([])), [call('c1', 'Sh', { command: 'make' }, 'allow_once')], { windowShared: () => answers.shift() ?? false } as never),
    );
    expect(resultOf(outcome).windowShared).toBe(true);
  });

  it('sets windowShared when the predicate is true at the start of the window', async () => {
    const answers = [true, false];
    const { harness } = setup([[]]);
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(sh([])), [call('c1', 'Sh', { command: 'make' }, 'allow_once')], { windowShared: () => answers.shift() ?? false } as never),
    );
    expect(resultOf(outcome).windowShared).toBe(true);
    expect(answers).toEqual([]);
  });

  it('leaves windowShared absent when the predicate is false at both ends', async () => {
    let asked = 0;
    const { harness } = setup([[]]);
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(sh([])), [call('c1', 'Sh', { command: 'make' }, 'allow_once')], {
        windowShared: () => {
          asked += 1;
          return false;
        },
      } as never),
    );
    expect(asked).toBe(2);
    expect(resultOf(outcome)).not.toHaveProperty('windowShared');
    expect(resultOf(outcome).files).toEqual([]);
  });
});
