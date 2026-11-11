import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, firstOfferedEndpointForm, loadUserSettings, registeredServer, requireOfferedEndpointForm } from '@momonga/config';
import { endpointFormsOfSocket, generationLayout } from '@momonga/foundation';
import type { EndpointScope } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import type { ManagedEndpointForm, ManagedServerDescription } from '@momonga/protocol';
import { makeHome, modelsOf, writeSettings } from '../gateway-process-helpers.ts';

const HOME = '/Users/someone';
const WIN_HOME = 'C:\\Users\\someone';

const accepting = (forms: readonly ManagedEndpointForm[]): ManagedServerDescription => ({ ...FM_SERVER, id: 'loom', endpoint: { forms } });

const declaring = (endpoint: Record<string, unknown> | undefined) => ({
  models: modelsOf(
    { workbench: { adapter: 'managed', server: 'loom', model: 'loom-1' } },
    { servers: { loom: { command: '/opt/loom/bin/loom', args: ['run', '--socket', '{socket}'], readyPath: '/ready', ...(endpoint === undefined ? {} : { endpoint }) } } },
  ),
});

const PIPES: EndpointScope = { form: 'pipe', token: '0123456789abcdef0123456789abcdef' };

describe('the endpoint forms of a managed server are data (design-update 18.2.6, 20.59)', () => {
  it('offers the form of the host socket flavour: unix for a filesystem path, pipe for a named pipe', () => {
    expect(endpointFormsOfSocket(generationLayout(HOME, 1, 'darwin').sockets.gateway)).toEqual(['unix']);
    expect(endpointFormsOfSocket(generationLayout(HOME, 1, 'linux').sockets.gateway)).toEqual(['unix']);
    expect(endpointFormsOfSocket(generationLayout(WIN_HOME, 1, 'win32', PIPES).sockets.gateway)).toEqual(['pipe']);
  });

  it('uses the first form of the description that the host offers', () => {
    expect(firstOfferedEndpointForm(accepting(['pipe', 'unix']), ['unix'])).toBe('unix');
    expect(firstOfferedEndpointForm(accepting(['pipe', 'unix']), ['pipe'])).toBe('pipe');
    expect(firstOfferedEndpointForm(accepting(['unix', 'pipe']), ['unix', 'pipe'])).toBe('unix');
    expect(FM_SERVER.endpoint).toEqual({ forms: ['unix'] });
  });

  it('refuses a description with no offered form, naming the platform and both lists of forms', () => {
    expect(() => requireOfferedEndpointForm(accepting(['unix']), { platform: 'win32', forms: ['pipe'] }, 'models.connections[0]')).toThrow(
      'models.connections[0]: the server "loom" cannot be used on win32: it accepts only the socket forms [unix], and win32 offers [pipe]',
    );
    expect(() => requireOfferedEndpointForm(accepting(['unix', 'pipe']), { platform: 'linux', forms: [] }, 'models.connections[0]')).toThrow('it accepts only the socket forms [unix, pipe], and linux offers []');
  });
});

describe.skipIf(process.platform === 'win32')('a server declared in the user settings may declare its endpoint forms (design-update 20.59)', () => {
  it('defaults to [unix] when the declaration names none', async () => {
    const home = makeHome();
    writeSettings(home, declaring(undefined));

    const { settings } = await loadUserSettings({ home, signal: new AbortController().signal });

    expect(registeredServer(settings.models.servers, 'loom')?.endpoint).toEqual({ forms: ['unix'] });
  });

  it('keeps the declared forms in their order', async () => {
    const home = makeHome();
    writeSettings(home, declaring({ forms: ['pipe', 'unix'] }));

    const { settings } = await loadUserSettings({ home, signal: new AbortController().signal });

    expect(registeredServer(settings.models.servers, 'loom')?.endpoint).toEqual({ forms: ['pipe', 'unix'] });
  });

  it('refuses at load a connection whose server accepts no form this host offers, naming the settings file', async () => {
    const home = makeHome();
    writeSettings(home, declaring({ forms: ['pipe'] }));
    const file = fs.realpathSync(path.join(home, '.momonga', 'settings.json'));

    const refusal = await loadUserSettings({ home, signal: new AbortController().signal }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConfigError);
    expect((refusal as Error).message).toContain(`${file}: models.connections[0]: the server "loom" cannot be used on ${process.platform}: it accepts only the socket forms [pipe], and ${process.platform} offers [unix]`);
  });

  it('refuses an endpoint form that is not one of unix and pipe by the schema', async () => {
    const home = makeHome();
    writeSettings(home, declaring({ forms: ['tcp'] }));

    expect(await loadUserSettings({ home, signal: new AbortController().signal }).catch((error: unknown) => error)).toBeInstanceOf(ConfigError);
  });
});
