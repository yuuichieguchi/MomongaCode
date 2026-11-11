import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';
import { requireOfferedEndpointForm, serverRegistryOf } from '../src/server-registry.ts';

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

describe('config-C12: a server no form of which the platform offers is refused with the platform and the cause', () => {
  const declared = serverRegistryOf({ loom: { command: '/opt/loom/bin/loom', args: ['--socket', '{socket}'], readyPath: '/ready' } }, 'settings.json')['loom'] as ManagedServerDescription;

  it('names the platform, the forms the server accepts and the forms the platform offers', () => {
    expect(() => requireOfferedEndpointForm(declared, { platform: 'win32', forms: ['pipe'] }, 'models.connections[0]')).toThrow(
      new config.ConfigError('models.connections[0]: the server "loom" cannot be used on win32: it accepts only the socket forms [unix], and win32 offers [pipe]'),
    );
  });

  it('does not end with the sentence that named no cause', () => {
    let message = '';
    try {
      requireOfferedEndpointForm(declared, { platform: 'win32', forms: ['pipe'] }, 'models.connections[0]');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('win32');
    expect(message).not.toContain('cannot be used on this platform');
  });

  it('returns the first accepted form the platform offers', () => {
    expect(requireOfferedEndpointForm(declared, { platform: 'linux', forms: ['unix'] }, 'models.connections[0]')).toBe('unix');
  });

  it('keeps the default readiness bound of a declared server', () => {
    expect(declared.ready.limitMs).toBe(10_000);
  });
});
