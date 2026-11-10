import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';
import { serverRegistryOf } from '../src/server-registry.ts';

const registeredServers = (registry: ServerRegistry): readonly ManagedServerDescription[] => {
  const value = (config as Record<string, unknown>)['registeredServers'];
  if (typeof value !== 'function') throw new Error('@momonga/config does not export registeredServers (design-chatgpt-plan O-R5-6 L9, (K) detail (e))');
  return (value as (registry: ServerRegistry) => readonly ManagedServerDescription[])(registry);
};

describe('O-R5-6 L9: registeredServers', () => {
  it('registeredServers returns every id of registeredIds with its description, in id order', () => {
    const registry = serverRegistryOf({ zeta: { command: '/opt/zeta/bin/serve', args: ['{socket}'], readyPath: '/health' }, alpha: { command: '/opt/alpha/serve', args: ['--socket', '{socket}'], readyPath: '/ready' } }, 'settings.json');
    const ids = config.registeredIds(registry);
    expect(ids).toContain('alpha');
    expect(ids).toContain('zeta');
    expect(registeredServers(registry)).toEqual(ids.map((id) => registry[id]));
    expect(registeredServers(registry).map((server) => server.id)).toEqual([...ids].sort());
  });
});
