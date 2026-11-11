import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@momonga/config';
import type { ToolEnv } from '@momonga/runtime';
import type { Session } from '@momonga/store';

import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { seedStartedCalls } from './cancel-fixture.ts';

const CALLS = [
  { callId: 'call_m_1', name: 'Mark', args: { value: 'one' } },
  { callId: 'call_m_2', name: 'Mark', args: { value: 'two' } },
];

const recover = async (env: Env, brokenSettings: boolean) => {
  if (brokenSettings) {
    const file = path.join(env.home, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "permissions": ');
  }
  const { run } = await seedStartedCalls(env, CALLS);
  const policyBuilds: Array<readonly PermissionRule[] | undefined> = [];
  const contexts: string[] = [];
  const worker = env.worker('worker-1', {
    ...(brokenSettings
      ? {
          settings: {
            ...env.settings,
            rules: async () => {
              throw new Error('recovery must not read settings');
            },
          },
        }
      : {}),
    tools: {
      policyFor: async (_session: Session, options: { env: ToolEnv; rules?: readonly PermissionRule[] }) => {
        policyBuilds.push(options.rules);
        throw new Error('recovery must not build a tool policy');
      },
      recoveryContextFor: async (session: Session, options: { env: ToolEnv }) => {
        contexts.push(session.id);
        return { roots: [session.cwd], tmpDir: env.sessionTmpDir, env: options.env };
      },
    },
  });
  await env.settled(env.runOnce(worker), 'the cancel recovery');
  return {
    status: env.run(run.id).status,
    reconciled: env.ofType(run.id, 'tool.reconciled').map((event) => ({ callId: event.callId, outcome: event.outcome, output: event.output })),
    policyBuilds,
    contexts,
    batchRules: env.batches.map((batch) => batch.rules),
  };
};

describe('cancel recovery with a broken user settings file', () => {
  it('recovers with the same outcomes as with a valid file and never reads settings rules', async () => {
    const valid = await recover(await makeEnv(), false);
    const broken = await recover(await makeEnv(), true);
    expect(valid.status).toBe('CANCELLED');
    expect(broken.status).toBe('CANCELLED');
    expect(broken.reconciled).toEqual(valid.reconciled);
    expect(broken.reconciled.map((entry) => entry.callId).sort()).toEqual(['call_m_1', 'call_m_2']);
    expect(broken.batchRules).toEqual([[]]);
    expect(broken.policyBuilds).toEqual([]);
    expect(broken.contexts).toHaveLength(1);
  });
});
