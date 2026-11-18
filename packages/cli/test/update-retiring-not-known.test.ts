import { describe, expect, it } from 'vitest';
import { installedText } from '../src/commands/update.ts';
import { retiringWorkOf } from '../src/daemon/generations.ts';
import type { LiveGeneration } from '../src/daemon/generations.ts';
import type { SupervisorHealth } from '@momonga/protocol';

const healthOf = (version: string, pid: number, counts: Partial<SupervisorHealth>): SupervisorHealth => ({
  status: 'ok',
  version,
  pid,
  startedAt: '2026-01-01T00:00:00.000Z',
  phase: 'running',
  env: 'frozen at supervisor start',
  children: [],
  logs: { droppedLines: 0 },
  retention: null,
  ...counts,
});

describe('momonga update over a retiring generation whose runtime did not answer in time (20.72)', () => {
  it('names that generation as not known instead of counting it as nothing', () => {
    const live: LiveGeneration[] = [
      { generation: 1, role: 'retiring', health: healthOf('1.2.3', 4001, { steps: 2, jobs: 1 }) },
      { generation: 2, role: 'retiring', health: healthOf('1.2.4', 4002, { calls: 0, countsNotKnown: ['runtime'] }) },
    ];

    const retiring = retiringWorkOf(live);

    expect(retiring).toEqual({ steps: 2, jobs: 1, versions: ['1.2.3', '1.2.4'], notKnown: ['v1.2.4 (pid 4002)'] });
    expect(installedText({ from: '1.2.4', to: '1.2.5', target: 't', daemon: { kind: 'restarted', retiring } })).toBe(
      'updated momonga 1.2.4 -> 1.2.5 (t)\nUpdated to v1.2.5. The daemon is running the new version now. 2 running steps and 1 background jobs of v1.2.3, v1.2.4 finish in the background, and the work of v1.2.4 (pid 4002) is not known: its runtime did not answer in time; nothing is interrupted.\n',
    );
  });

  it('does not say the new version simply runs when the only retiring work is not known', () => {
    const retiring = retiringWorkOf([{ generation: 1, role: 'retiring', health: healthOf('1.2.4', 4002, { countsNotKnown: ['runtime'] }) }]);

    expect(installedText({ from: '1.2.4', to: '1.2.5', target: 't', daemon: { kind: 'restarted', retiring } })).toBe(
      'updated momonga 1.2.4 -> 1.2.5 (t)\nUpdated to v1.2.5. The daemon is running the new version now. 0 running steps and 0 background jobs of v1.2.4 finish in the background, and the work of v1.2.4 (pid 4002) is not known: its runtime did not answer in time; nothing is interrupted.\n',
    );
  });
});
