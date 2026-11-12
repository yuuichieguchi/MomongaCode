import { describe, expect, it, vi } from 'vitest';
import { NO_NETWORK, OPEN_NETWORK } from '@momonga/foundation';
import type { NetworkScope, SandboxNetworkSetting } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { callNetworkOf } from '../src/network-scope.ts';
import { HAS_RG, RG_PATH, makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { makeLayout } from './helpers.ts';
import { HAS_REAL_SANDBOX, realSandbox, recordingSandbox, scratchRootOf } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HOSTS: NetworkScope = { kind: 'hosts', hosts: ['example.org'] };

describe('the one network scope table', () => {
  it('gives each sandbox the policy network it can keep for what the call requests and was granted', () => {
    expect(callNetworkOf({ requested: NO_NETWORK, granted: NO_NETWORK, sandbox: 'seatbelt' })).toEqual({ kind: 'admitted', scope: NO_NETWORK, sandboxNetwork: 'deny' });
    expect(callNetworkOf({ requested: HOSTS, granted: HOSTS, sandbox: 'bubblewrap' })).toEqual({ kind: 'admitted', scope: HOSTS, sandboxNetwork: 'deny' });
    expect(callNetworkOf({ requested: OPEN_NETWORK, granted: OPEN_NETWORK, sandbox: 'bubblewrap' })).toEqual({ kind: 'admitted', scope: OPEN_NETWORK, sandboxNetwork: 'allow' });
    expect(callNetworkOf({ requested: OPEN_NETWORK, granted: NO_NETWORK, sandbox: 'seatbelt' })).toEqual({ kind: 'admitted', scope: NO_NETWORK, sandboxNetwork: 'deny' });
    expect(callNetworkOf({ requested: NO_NETWORK, granted: NO_NETWORK, sandbox: 'none' })).toEqual({ kind: 'admitted', scope: NO_NETWORK, sandboxNetwork: 'allow' });
    expect(callNetworkOf({ requested: OPEN_NETWORK, granted: OPEN_NETWORK, sandbox: 'none' })).toEqual({ kind: 'admitted', scope: OPEN_NETWORK, sandboxNetwork: 'allow' });
  });

  it('refuses a scope the sandbox cannot keep and names the form it accepts', () => {
    const refused = callNetworkOf({ requested: HOSTS, granted: HOSTS, sandbox: 'none' });
    expect(refused.kind).toBe('refused');
    expect(refused.kind === 'refused' ? refused.reason : '').toContain('network access to example.org only');
    expect(refused.kind === 'refused' ? refused.reason : '').toContain('"open"');
  });
});

type Row = { sandbox: Sandbox['kind']; network?: 'open' | { hosts: string[] }; setting: SandboxNetworkSetting; spawned?: RecordedSpawn['policy']['network'] | 'proxy'; denial?: { source: string; contains: string } };

const ROWS: readonly Row[] = [
  { sandbox: 'seatbelt', setting: 'ask', spawned: 'deny' },
  { sandbox: 'seatbelt', network: { hosts: ['example.org'] }, setting: 'ask', spawned: 'proxy' },
  { sandbox: 'seatbelt', network: 'open', setting: 'ask', spawned: 'allow' },
  { sandbox: 'seatbelt', network: 'open', setting: 'deny', denial: { source: 'setting', contains: 'sandboxNetwork is deny' } },
  { sandbox: 'bubblewrap', setting: 'allow', spawned: 'deny' },
  { sandbox: 'bubblewrap', network: { hosts: ['example.org'] }, setting: 'allow', spawned: 'proxy' },
  { sandbox: 'bubblewrap', network: 'open', setting: 'allow', spawned: 'allow' },
  { sandbox: 'bubblewrap', network: { hosts: ['example.org'] }, setting: 'deny', denial: { source: 'setting', contains: 'sandboxNetwork is deny' } },
  { sandbox: 'none', setting: 'allow', spawned: 'allow' },
  { sandbox: 'none', setting: 'ask', spawned: 'allow' },
  { sandbox: 'none', network: 'open', setting: 'ask', spawned: 'allow' },
  { sandbox: 'none', network: { hosts: ['example.org'] }, setting: 'allow', denial: { source: 'sandbox', contains: '"open"' } },
];

const labelled = (kind: Sandbox['kind']): { sandbox: Sandbox; spawns: RecordedSpawn[] } => {
  const recorded = recordingSandbox(realSandbox(scratchRootOf(makeLayout().root)));
  return { sandbox: { ...recorded.sandbox, kind }, spawns: recorded.spawns };
};

const shapeOf = (network: RecordedSpawn['policy']['network']): RecordedSpawn['policy']['network'] | 'proxy' => (typeof network === 'object' ? 'proxy' : network);

describe.runIf(HAS_REAL_SANDBOX)('the executor takes the policy network of a Bash call from the table', () => {
  for (const row of ROWS) {
    it(`${row.sandbox}, network ${JSON.stringify(row.network ?? null)}, setting ${row.setting}`, async () => {
      const { sandbox, spawns } = labelled(row.sandbox);
      const tools = await makeBuiltins({ sandbox });
      const outcome = await tools.run('Bash', { command: 'touch made', ...(row.network === undefined ? {} : { network: row.network }) }, { mode: 'manual', sandboxNetwork: row.setting }, 'allow_once');
      const result = resultOf(outcome);
      if (row.denial !== undefined) {
        expect(result.denial?.source).toBe(row.denial.source);
        expect(result.denial?.reason).toContain(row.denial.contains);
        expect(spawns).toEqual([]);
        return;
      }
      expect(spawns.map((spawn) => shapeOf(spawn.policy.network))).toEqual([row.spawned]);
    });
  }
});

describe.runIf(HAS_REAL_SANDBOX && HAS_RG)('Grep takes its policy network from the same table', () => {
  it('runs ripgrep with the network the unsandboxed host has under the sandbox none and the setting allow', async () => {
    const { sandbox, spawns } = labelled('none');
    const tools = await makeBuiltins({ sandbox });
    tools.write('a.txt', 'needle\n');
    await tools.run('Grep', { pattern: 'needle', path: tools.layout.project }, { mode: 'manual', sandboxNetwork: 'allow', env: { PATH: RG_PATH, LANG: 'C' } }, 'allow_once');
    expect(spawns.length).toBeGreaterThan(0);
    expect(new Set(spawns.map((spawn) => spawn.policy.network))).toEqual(new Set(['allow']));
  });

  it('runs ripgrep without the network under a real sandbox', async () => {
    const { sandbox, spawns } = labelled('seatbelt');
    const tools = await makeBuiltins({ sandbox });
    tools.write('a.txt', 'needle\n');
    await tools.run('Grep', { pattern: 'needle', path: tools.layout.project }, { mode: 'manual', sandboxNetwork: 'allow', env: { PATH: RG_PATH, LANG: 'C' } }, 'allow_once');
    expect(spawns.length).toBeGreaterThan(0);
    expect(new Set(spawns.map((spawn) => spawn.policy.network))).toEqual(new Set(['deny']));
  });
});
