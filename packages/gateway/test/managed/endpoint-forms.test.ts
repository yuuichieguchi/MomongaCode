import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, firstOfferedEndpointForm, loadUserSettings, registeredServer, requireOfferedEndpointForm } from '@momonga/config';
import { endpointFormsOfSocket, generationLayout, pipePathFor } from '@momonga/foundation';
import { instanceSocketOf } from '@momonga/gateway';
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

describe('the endpoint forms of a managed server are data (design-update 18.2.6, 20.59)', () => {
  it('offers the form of the host socket flavour: unix for a filesystem path, pipe for a named pipe', () => {
    expect(endpointFormsOfSocket(generationLayout(HOME, 1, 'darwin').sockets.gateway)).toEqual(['unix']);
    expect(endpointFormsOfSocket(generationLayout(HOME, 1, 'linux').sockets.gateway)).toEqual(['unix']);
    expect(endpointFormsOfSocket(generationLayout(WIN_HOME, 1, 'win32').sockets.gateway)).toEqual(['pipe']);
  });

  it('uses the first form of the description that the host offers', () => {
    expect(firstOfferedEndpointForm(accepting(['pipe', 'unix']), ['unix'])).toBe('unix');
    expect(firstOfferedEndpointForm(accepting(['pipe', 'unix']), ['pipe'])).toBe('pipe');
    expect(firstOfferedEndpointForm(accepting(['unix', 'pipe']), ['unix', 'pipe'])).toBe('unix');
    expect(FM_SERVER.endpoint).toEqual({ forms: ['unix'] });
  });

  it('refuses a description with no offered form with the text of 18.2.6', () => {
    expect(() => requireOfferedEndpointForm(accepting(['unix']), ['pipe'], 'models.connections[0]')).toThrow(
      'models.connections[0]: server "loom" accepts only the endpoint forms [unix], and this host offers [pipe]; the target cannot be used on this platform',
    );
    expect(() => requireOfferedEndpointForm(accepting(['unix', 'pipe']), [], 'models.connections[0]')).toThrow('accepts only the endpoint forms [unix, pipe], and this host offers []');
  });

  it('places a pipe instance at pipePathFor(home, g<N>-managed-<stem>) and leaves a unix instance at its socket file', () => {
    const unixSocket = path.join(HOME, '.momonga', 'run', 'g2', 'targets', 'apple-1.sock');
    expect(instanceSocketOf('pipe', unixSocket, HOME, 2)).toBe(pipePathFor(HOME, 'g2-managed-apple-1'));
    expect(instanceSocketOf('pipe', path.join(HOME, '.momonga', 'run', 'g2', 'targets', '_probe-apple.sock'), HOME, 2)).toBe(pipePathFor(HOME, 'g2-managed-_probe-apple'));
    expect(instanceSocketOf('unix', unixSocket, HOME, 2)).toBe(unixSocket);
  });
});

describe.skipIf(process.platform === 'win32')('a server declared in the user settings may declare its endpoint forms (design-update 20.59)', () => {
  it('defaults to [unix] when the declaration names none', async () => {
    const home = makeHome();
    writeSettings(home, declaring(undefined));

    const { settings } = await loadUserSettings({ home });

    expect(registeredServer(settings.models.servers, 'loom')?.endpoint).toEqual({ forms: ['unix'] });
  });

  it('keeps the declared forms in their order', async () => {
    const home = makeHome();
    writeSettings(home, declaring({ forms: ['pipe', 'unix'] }));

    const { settings } = await loadUserSettings({ home });

    expect(registeredServer(settings.models.servers, 'loom')?.endpoint).toEqual({ forms: ['pipe', 'unix'] });
  });

  it('refuses at load a connection whose server accepts no form this host offers, naming the settings file', async () => {
    const home = makeHome();
    writeSettings(home, declaring({ forms: ['pipe'] }));
    const file = fs.realpathSync(path.join(home, '.momonga', 'settings.json'));

    const refusal = await loadUserSettings({ home }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConfigError);
    expect((refusal as Error).message).toContain(`${file}: models.connections[0]: server "loom" accepts only the endpoint forms [pipe], and this host offers [unix]; the target cannot be used on this platform`);
  });

  it('refuses an endpoint form that is not one of unix and pipe by the schema', async () => {
    const home = makeHome();
    writeSettings(home, declaring({ forms: ['tcp'] }));

    expect(await loadUserSettings({ home }).catch((error: unknown) => error)).toBeInstanceOf(ConfigError);
  });
});
