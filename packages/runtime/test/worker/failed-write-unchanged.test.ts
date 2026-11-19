import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completionMutates, reconciliationMutates } from '@momonga/protocol';
import { NO_CHECK_DECLARED_CODE } from '@momonga/runtime';
import { createBuiltinTools } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const REAL_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

const withRealFileTools = (env: Env): (() => AnyTool[]) => () => [
  ...env.toolbox.tools().filter((tool) => !REAL_FILE_TOOLS.has(tool.name)),
  ...createBuiltinTools({ sandbox: 'seatbelt', sandboxNetwork: 'deny', bash: { kind: 'resolved', path: '/bin/bash' } }).filter((tool) => REAL_FILE_TOOLS.has(tool.name)),
];

const lockedFolders: string[] = [];

afterEach(() => {
  for (const folder of lockedFolders.splice(0)) fs.chmodSync(folder, 0o755);
});

const lockedFolderIn = (env: Env): string => {
  const folder = path.join(env.project, 'locked');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'kept.txt'), 'kept\n');
  fs.chmodSync(folder, 0o555);
  lockedFolders.push(folder);
  return folder;
};

const noticesOf = (env: Env, runId: string) => env.fold(runId).notes.filter((note) => note.code === NO_CHECK_DECLARED_CODE);

describe('a failed write that its writer proved left the workspace unchanged is not a change of the workspace', () => {
  it('a Write refused by a folder without write permission ends without the notice and with no mutation', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const folder = lockedFolderIn(env);
    env.gateway.script.push(callsStep([{ callId: 'call_w', name: 'Write', args: { file_path: path.join(folder, 'new.txt'), content: 'x' } }]), textStep('Could not write.'));
    const run = await env.enqueue('Write the file');

    await env.runOnce(env.worker('worker-1', { toolList: withRealFileTools(env) }));

    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ status: 'failed', workspaceUnchanged: true })]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.fold(run.id).lastMutationSeq).toBe(0);
    expect(noticesOf(env, run.id)).toEqual([]);
    expect(fs.readdirSync(folder)).toEqual(['kept.txt']);
  });

  it('a completed Write still shows the notice', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_w', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]), textStep('Written.'));
    const run = await env.enqueue('Write the file');

    await env.runOnce(env.worker('worker-1', { toolList: withRealFileTools(env) }));

    expect(env.ofType(run.id, 'tool.completed')[0]).not.toHaveProperty('workspaceUnchanged');
    expect(noticesOf(env, run.id)).toHaveLength(1);
  });

  it('a failed Write followed by a completed Write shows the notice', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const folder = lockedFolderIn(env);
    env.gateway.script.push(
      callsStep([{ callId: 'call_w1', name: 'Write', args: { file_path: path.join(folder, 'new.txt'), content: 'x' } }]),
      callsStep([{ callId: 'call_w2', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]),
      textStep('Written.'),
    );
    const run = await env.enqueue('Write the file');

    await env.runOnce(env.worker('worker-1', { toolList: withRealFileTools(env) }));

    expect(env.ofType(run.id, 'tool.completed').map((event) => event.status)).toEqual(['failed', 'completed']);
    expect(env.fold(run.id).lastMutationSeq).toBeGreaterThan(0);
    expect(noticesOf(env, run.id)).toHaveLength(1);
  });
});

describe('every other failed or unknown call stays a change of the workspace', () => {
  const write = { sideEffect: 'write' as const, rejected: false };
  const exec = { sideEffect: 'exec' as const, rejected: false };

  it('a failed Bash counts', () => {
    expect(completionMutates(exec, { status: 'failed' })).toBe(true);
  });

  it('a failed write without the writer\'s proof counts', () => {
    expect(completionMutates(write, { status: 'failed' })).toBe(true);
  });

  it('a failed write with the writer\'s proof does not count, unless a change was observed', () => {
    expect(completionMutates(write, { status: 'failed', workspaceUnchanged: true })).toBe(false);
    expect(completionMutates(write, { status: 'failed', workspaceUnchanged: true, mutated: true })).toBe(true);
  });

  it('an unknown outcome counts', () => {
    expect(reconciliationMutates(write, 'unknown')).toBe(true);
  });
});
