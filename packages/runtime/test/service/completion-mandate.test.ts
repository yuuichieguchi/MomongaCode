import { parseRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { describe, expect, it } from 'vitest';
import { expectError, startService } from './helpers.ts';

const deny = (text: string): PermissionRule => parseRule(text, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: '/w', home: '/h', cwd: '/w' });

const request = (command: string) => ({ input: 'make it pass', mandate: { completion: { conditions: [{ command }] } } });

describe('the completion conditions of a run request', () => {
  it('refuses a condition that a deny rule matches, names the rule, and creates no run', async () => {
    const env = await startService({ permissionRules: async () => [deny('Bash(rm:*)')] });
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: request('rm -rf build') });

    expectError(response, 400, 'invalid_request');
    expect(JSON.stringify(response.json)).toContain('Bash(rm:*)');
    expect(JSON.stringify(response.json)).toContain('rm -rf build');
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('refuses the second condition when only the second is denied', async () => {
    const env = await startService({ permissionRules: async () => [deny('Bash(rm:*)')] });
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, {
      body: { input: 'x', mandate: { completion: { conditions: [{ command: 'npm test' }, { command: 'rm -rf build' }] } } },
    });

    expectError(response, 400, 'invalid_request');
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('accepts a condition no deny rule matches and pins the mandate on the run', async () => {
    const env = await startService({ permissionRules: async () => [deny('Bash(rm:*)')] });
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: request('npm test') });

    expect(response.status).toBe(202);
    expect(env.store.getRun(response.json.run.id)?.pins).toEqual({ mandate: { completion: { conditions: [{ command: 'npm test' }] } } });
  });

  it('does not ask the rules at all for a request without conditions', async () => {
    let asked = 0;
    const env = await startService({
      permissionRules: async () => {
        asked += 1;
        return [deny('Bash(rm:*)')];
      },
    });
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'plain' } });

    expect(response.status).toBe(202);
    expect(asked).toBe(0);
  });
});
