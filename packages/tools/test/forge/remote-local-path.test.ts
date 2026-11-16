import { describe, expect, it } from 'vitest';
import { hostedRemoteOf } from '../../src/forge/remote.ts';
import { networkScopeOfDestinations } from '../../src/operations/argv.ts';

describe('a remote written as a local path is a local remote, not a host', () => {
  it.each(['C:/repo', 'D:\\repos\\app', './repo', '../sibling/repo'])('%s names no forge', (remote) => {
    expect(hostedRemoteOf(remote)).toBeUndefined();
  });

  it.each(['C:/repo', './repo'])('%s reaches no network', (destination) => {
    expect(networkScopeOfDestinations([destination], 'git')).toEqual({ kind: 'none' });
  });

  it('keeps an SCP-style remote with a host name as a hosted remote', () => {
    expect(hostedRemoteOf('git@github.com:owner/repo.git')).toEqual({ hostname: 'github.com', repo: 'owner/repo' });
  });
});
