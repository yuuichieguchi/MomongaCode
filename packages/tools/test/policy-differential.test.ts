import fs from 'node:fs';
import path from 'node:path';
import { GIT_OPTION_TABLES } from '@momonga/policy';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { RELOCATABLE_LINKS, makeDifferentialWorkspace } from './differential/fixture.ts';
import { generate, seededRng } from './differential/generator.ts';
import { runCase } from './differential/oracles.ts';
import type { Case } from './differential/oracles.ts';
import { PLACEHOLDER_PATHS, SEPARATE_WORD_SUBCOMMANDS, editSeeds, optionWordSweep, readSeeds, separateWordSweep } from './differential/seeds.ts';

vi.setConfig({ testTimeout: 10 * REAL_PROCESS_TEST_TIMEOUT_MS });


const SEED_CHUNK = 8;
const GENERATED_SEEDS = [1, 2, 3, 4, 5, 6];
const CASES_PER_SEED = 24;

const failures = async (cases: readonly Case[], run: (input: Case) => ReturnType<typeof runCase>): Promise<{ approved: number; failures: string[] }> => {
  const found: string[] = [];
  let approved = 0;
  for (const input of cases) {
    const outcome = await run(input);
    if (outcome.ran) approved += 1;
    for (const violation of outcome.violations) found.push(`${JSON.stringify(input)}: ${violation}`);
  }
  return { approved, failures: found };
};

describe('every command decide approves does what the analysis reported, on real /bin/bash and real git', () => {
  const readCount = readSeeds(PLACEHOLDER_PATHS).length;

  it.each(Array.from({ length: Math.ceil(readCount / SEED_CHUNK) }, (_, chunk) => chunk))('bypasses reported in both review rounds, chunk %i', async (chunk) => {
    const workspace = makeDifferentialWorkspace();
    const cases = readSeeds(workspace).slice(chunk * SEED_CHUNK, (chunk + 1) * SEED_CHUNK);
    expect((await failures(cases, (input) => runCase(workspace, input))).failures).toEqual([]);
  });

  it.each(Array.from({ length: editSeeds(PLACEHOLDER_PATHS).length },(_, index) => index))('repositories created by the same command, case %i', async (index) => {
    const workspace = makeDifferentialWorkspace();
    const input = editSeeds(workspace)[index] as Case;
    expect((await runCase(workspace, input)).violations, input.command).toEqual([]);
  });

  it.each(GENERATED_SEEDS)('seeded generator, seed %i', async (seed) => {
    expect(CASES_PER_SEED).toBeLessThanOrEqual(RELOCATABLE_LINKS);
    const workspace = makeDifferentialWorkspace();
    const cases = generate(seededRng(seed), workspace, CASES_PER_SEED);
    const result = await failures(cases, (input) => runCase(workspace, input));
    expect(result.failures).toEqual([]);
    expect(result.approved).toBeGreaterThan(0);
  });

  it.each(Object.keys(GIT_OPTION_TABLES))('every value option of git %s followed by an option word', async (subcommand) => {
    const workspace = makeDifferentialWorkspace();
    workspace.write('tracked', 'two\n');
    expect(workspace.git(workspace.project, 'commit', '-q', '-a', '-m', 'two').status).toBe(0);
    workspace.git(workspace.project, 'config', 'diff.external', workspace.hookScript('echo'));
    workspace.git(workspace.project, 'log', '--ext-diff', '-p', '-1');
    expect(workspace.firedMarkers()).toEqual(['fired-echo']);
    fs.rmSync(path.join(workspace.base, 'fired-echo'));
    const values = (GIT_OPTION_TABLES[subcommand] as { values: readonly string[] }).values;
    expect((await failures(optionWordSweep(values, subcommand), (input) => runCase(workspace, input))).failures).toEqual([]);
  });

  it.each(SEPARATE_WORD_SUBCOMMANDS)('every option of git %s followed by a side-effect option word, with and without a separator', async (subcommand) => {
    const workspace = makeDifferentialWorkspace();
    fs.copyFileSync(workspace.hookScript('echo'), path.join(workspace.project, 'pager.sh'));
    fs.chmodSync(path.join(workspace.project, 'pager.sh'), 0o755);
    workspace.write('.gitattributes', 'tracked diff=x\n');
    workspace.git(workspace.project, 'config', 'diff.x.textconv', workspace.hookScript('echo'));
    workspace.write('two', 'two\n');
    workspace.git(workspace.project, 'add', 'two');
    workspace.git(workspace.project, 'commit', '-q', '-m', 'two');
    const table = GIT_OPTION_TABLES[subcommand] as { flags: readonly string[]; values: readonly string[]; optionalValues: readonly string[] };
    const options = [...table.flags, ...table.values, ...table.optionalValues];
    const swept = separateWordSweep(subcommand, options);
    expect(swept.length).toBeGreaterThan(options.length);
    expect((await failures(swept, (input) => runCase(workspace, input))).failures).toEqual([]);
  });
});

describe('the oracle reports what an approved command really did, whatever decide said', () => {
  const approvingAll = (): ReturnType<typeof makeDifferentialWorkspace> => {
    const workspace = makeDifferentialWorkspace();
    return { ...workspace, decideExpanding: async () => ({ kind: 'allow', reason: 'forced by the oracle test' }) as Awaited<ReturnType<typeof workspace.decideExpanding>> };
  };

  it('a write inside .git is a violation in acceptEdits', async () => {
    const workspace = approvingAll();
    const outcome = await runCase(workspace, { command: 'echo x > .git/info/exclude', mode: 'acceptEdits' });
    expect(outcome.violations.join('\n')).toContain('.git/info/exclude');
  });

  it('a read through an option value containing = is a violation', async () => {
    const workspace = approvingAll();
    const outcome = await runCase(workspace, { command: 'grep --file=../CANARY-top a' });
    expect(outcome.violations.join('\n')).toContain('CANARY-top');
  });

  it('a change no reported target covers is a violation in acceptEdits', async () => {
    const workspace = approvingAll();
    workspace.write('run.sh', '#!/bin/sh\ntouch unreported\n', 0o755);
    const outcome = await runCase(workspace, { command: './run.sh', mode: 'acceptEdits' });
    expect(outcome.violations.join('\n')).toContain(`${workspace.project}/unreported`);
  });

  it('a reported write stays permitted in acceptEdits', async () => {
    const workspace = approvingAll();
    expect((await runCase(workspace, { command: 'touch reported', mode: 'acceptEdits' })).violations).toEqual([]);
  });
});
