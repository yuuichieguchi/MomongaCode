import { describe, expect, it } from 'vitest';
import { clearUntrustedSchemaCaches, untrustedSchemaFailure } from '@momonga/foundation';
import { schemaIdentity } from '@momonga/tools';
import { FIXTURE_EXTRA_TOOLS_ENV } from '@momonga/testkit';
import { entry, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const ENGINE_MESSAGE = 'props0 is not defined';
const withThrower = () => modernConfig(makeRecordFile(), { [FIXTURE_EXTRA_TOOLS_ENV]: 'validator_throws' });

describe('a validate-time failure of a tool whose schema another server sends identically', () => {
  it('leaves the other server tool registered and subject to its own validation', async () => {
    const pool = makePool([entry('alpha', withThrower()), entry('beta', withThrower())]);
    const set = await pool.snapshot();
    const alpha = 'mcp__alpha__validator_throws';
    const beta = 'mcp__beta__validator_throws';
    expect(set.get(alpha)).toBeDefined();
    expect(set.get(beta)).toBeDefined();
    const warnings: string[] = [];
    const executor = makeExecutor(undefined, (message) => warnings.push(message));

    await executor.run(set, alpha, {});
    expect(warnings.filter((message) => message.includes(alpha))).toHaveLength(1);
    expect(warnings.filter((message) => message.includes(beta))).toEqual([]);

    await executor.run(set, beta, {});
    const betaNotices = warnings.filter((message) => message.includes(beta));
    expect(betaNotices).toHaveLength(1);
    expect(betaNotices[0]).toContain(ENGINE_MESSAGE);
  });

  it('skips only the failed tool from the next snapshot', async () => {
    const pool = makePool([entry('gamma', withThrower()), entry('delta', withThrower())]);
    const set = await pool.snapshot();
    await makeExecutor().run(set, 'mcp__gamma__validator_throws', {});
    const next = await pool.snapshot();
    expect(next.get('mcp__gamma__validator_throws')).toBeUndefined();
    expect(next.get('mcp__delta__validator_throws')).toBeDefined();
  });

  it('gives every run that refuses the tool its own notice, once per run', async () => {
    const pool = makePool([entry('epsilon', withThrower())]);
    const set = await pool.snapshot();
    const name = 'mcp__epsilon__validator_throws';
    const warnings: string[] = [];
    const executor = makeExecutor(undefined, (message) => warnings.push(message));
    const sameRun = { runId: 'run-shared', fence: { runId: 'run-shared', workerId: 'w1', leaseToken: 1 } };

    await executor.run(set, name, {}, sameRun);
    await executor.run(set, name, {}, sameRun);
    expect(warnings.filter((message) => message.includes(name))).toHaveLength(1);

    const other = await executor.run(set, name, {}, { runId: 'run-other' });
    expect(other).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(warnings.filter((message) => message.includes(name))).toHaveLength(2);

    const next = await pool.snapshot();
    expect(next.get(name)).toBeUndefined();
  });

  it('refuses from the run journal after the process memory is lost, without validating again', async () => {
    const pool = makePool([entry('zeta', withThrower())]);
    const set = await pool.snapshot();
    const name = 'mcp__zeta__validator_throws';
    const tool = set.get(name);
    if (tool === undefined) throw new Error(`${name} is not registered`);
    const warnings: string[] = [];
    const executor = makeExecutor(undefined, (message) => warnings.push(message));
    const live = { runId: 'run-live' };

    await executor.run(set, name, {}, live);
    expect(untrustedSchemaFailure(schemaIdentity(tool), tool.inputSchema)).toContain(ENGINE_MESSAGE);

    clearUntrustedSchemaCaches();
    const again = await executor.run(set, name, {}, live);
    expect(again).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(untrustedSchemaFailure(schemaIdentity(tool), tool.inputSchema)).toBeUndefined();
    expect(warnings.filter((message) => message.includes(name))).toHaveLength(1);
  });
});
