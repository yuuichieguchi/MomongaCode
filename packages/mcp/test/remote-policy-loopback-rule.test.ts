import { describe, expect, it } from 'vitest';
import { claimsLoopback } from '@momonga/foundation';
import { assertRemoteUrl } from '../src/remote-policy.ts';

const refusedForProject = (host: string): boolean => {
  try {
    assertRemoteUrl(`https://${host}/mcp`, 'project');
    return false;
  } catch {
    return true;
  }
};

describe('a project MCP server URL is refused by the one loopback rule of the product', () => {
  it.each(['localhost', 'app.localhost', 'localhost.', 'a.b.localhost', 'example.com', 'localhost.example.com', 'notlocalhost'])('refuses %s exactly when the name claims this machine', (host) => {
    expect(refusedForProject(host)).toBe(claimsLoopback(host));
  });
});
