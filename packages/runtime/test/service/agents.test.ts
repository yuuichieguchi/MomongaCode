import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERAL_PURPOSE_AGENT } from '@momonga/agents';
import { startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const writeAgent = (directory: string, name: string, description: string): string => {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`);
  return file;
};

const BUILT_IN = { name: 'general-purpose', description: GENERAL_PURPOSE_AGENT.description, scope: 'builtin' };

const projectAgents = (env: ServiceEnv): string => path.join(env.layout.project, '.momonga', 'agents');

describe('GET /v1/sessions/:id/agents', () => {
  it('lists the built-in agent first, with no location, then the agents of the session with their scope and location', async () => {
    const env = await startService();
    const reviewer = writeAgent(projectAgents(env), 'reviewer', 'Reviews code');
    const session = await env.createSession();

    const response = await env.http('GET', `/v1/sessions/${session.id}/agents`);

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ agents: [BUILT_IN, { name: 'reviewer', description: 'Reviews code', scope: 'project', location: reviewer }], warnings: [] });
  });

  it('answers the load warnings of an untrusted folder', async () => {
    const env = await startService({ skillsTrusted: () => false });
    writeAgent(projectAgents(env), 'reviewer', 'Reviews code');
    const session = await env.createSession();

    const response = await env.http('GET', `/v1/sessions/${session.id}/agents`);

    expect(response.json).toEqual({ agents: [BUILT_IN], warnings: [`Project agents in ${projectAgents(env)} were skipped because the folder is not trusted`] });
  });
});
