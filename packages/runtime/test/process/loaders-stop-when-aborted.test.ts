import { describe, expect, it, vi } from 'vitest';
import type { SkillLoader } from '@momonga/skills';
import { createAgentsPort } from '../../src/process/agents-port.ts';
import { createSkillsPort } from '../../src/process/skills-port.ts';
import type { Session } from '@momonga/store';

const session = { id: 'session-1', cwd: '/work/project' } as unknown as Session;

describe('the loaders of a run are not started for an asker that has gone', () => {
  it('the trust read and the skill load are not started for an aborted request', async () => {
    const load = vi.fn<SkillLoader['load']>();
    const trusted = vi.fn(async () => true);
    const request = new AbortController();
    request.abort(new Error('the request was closed'));

    await expect(createSkillsPort({ loader: { load }, settings: { trusted } }).load(session, request.signal)).rejects.toThrow('the request was closed');

    expect(trusted).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('the agent catalogue is not read for an aborted request', async () => {
    const trusted = vi.fn(async () => true);
    const approvedProjectAgents = vi.fn(async () => new Set<string>());
    const request = new AbortController();
    request.abort(new Error('the request was closed'));
    const port = createAgentsPort({
      home: '/home/user',
      fileSystem: {} as never,
      settings: { trusted, approvedProjectAgents },
      runs: {} as never,
    });

    await expect(port.load(session, request.signal)).rejects.toThrow('the request was closed');

    expect(trusted).not.toHaveBeenCalled();
    expect(approvedProjectAgents).not.toHaveBeenCalled();
  });
});
