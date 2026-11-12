import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileIdentityComponentOf, readProbeKeyComponents } from '@momonga/foundation';
import type { HostExec } from '@momonga/foundation';
import * as config from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';
import { probeKeyOf } from '../src/probe-key.ts';
import type { ProbeKey } from '../src/probe-key.ts';
import { requireOfferedEndpointForm, serverRegistryOf } from '../src/server-registry.ts';
import { createTempDir } from '@momonga/testkit';

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

describe('config-C13: the record key of a declared server covers the file each path argument names', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  const makeDirectory = (): string => {
    const directory = createTempDir();
    directories.push(directory);
    return directory;
  };
  const placed = (file: string, content: string): string => {
    const staged = `${file}.staged`;
    fs.writeFileSync(staged, content);
    fs.renameSync(staged, file);
    return file;
  };
  const osBuild: HostExec = async () => ({ exitCode: 0, stdout: '25A100\n', stderr: '' });
  const declaredWith = (args: readonly string[], command = '/opt/loom/bin/loom'): ManagedServerDescription =>
    serverRegistryOf({ loom: { command, args: [...args], readyPath: '/ready' } }, 'settings.json')['loom'] as ManagedServerDescription;
  const keyOf = async (description: ManagedServerDescription, binary: string): Promise<ProbeKey> =>
    probeKeyOf({
      subject: description.id,
      identity: description.identity,
      readings: await readProbeKeyComponents({ identity: description.identity, binary, platform: 'darwin', exec: osBuild, signal: new AbortController().signal }),
      model: 'loom-1',
    });

  it('lists the binary digest, the OS build and one file identity per path argument, whole or after the equals sign of an option', () => {
    expect(declaredWith(['serve', '--model', '/models/weights.gguf', '--adapter=/models/adapter.bin', '--threads', '4', '--socket', '{socket}']).identity).toEqual([
      'binarySha256',
      'hostOsBuild',
      fileIdentityComponentOf('/models/weights.gguf'),
      fileIdentityComponentOf('/models/adapter.bin'),
    ]);
  });

  it('lists a path once when two arguments name it, and none for a server without path arguments', () => {
    expect(declaredWith(['--model', '/models/weights.gguf', '--draft=/models/weights.gguf', '{socket}']).identity).toEqual(['binarySha256', 'hostOsBuild', fileIdentityComponentOf('/models/weights.gguf')]);
    expect(declaredWith(['serve', 'relative/weights.gguf', '--socket', '{socket}']).identity).toEqual(['binarySha256', 'hostOsBuild']);
  });

  it('changes the key when the file of a path argument is replaced at the same path, and keeps it while the file stays', async () => {
    const directory = makeDirectory();
    const binary = placed(path.join(directory, 'loom'), '#!/bin/sh\n');
    const weights = placed(path.join(directory, 'weights.gguf'), 'the first model');
    const description = declaredWith(['--model', weights, '{socket}'], binary);

    const first = await keyOf(description, binary);
    const again = await keyOf(description, binary);
    placed(weights, 'another model!!');
    const replaced = await keyOf(description, binary);

    expect(first.kind).toBe('known');
    expect(again).toEqual(first);
    expect(replaced.kind).toBe('known');
    expect((replaced as { digest: string }).digest).not.toBe((first as { digest: string }).digest);
    expect(Object.keys((first as { fields: Record<string, unknown> }).fields)).toContain(fileIdentityComponentOf(weights));
  });

  it('gives a path that names no file an identity of its own, which changes when a file appears there', async () => {
    const directory = makeDirectory();
    const binary = placed(path.join(directory, 'loom'), '#!/bin/sh\n');
    const weights = path.join(directory, 'weights.gguf');
    const description = declaredWith(['--model', weights, '{socket}'], binary);

    const absent = await keyOf(description, binary);
    placed(weights, 'a model');
    const present = await keyOf(description, binary);

    expect(absent.kind).toBe('known');
    expect(present.kind).toBe('known');
    expect((present as { digest: string }).digest).not.toBe((absent as { digest: string }).digest);
  });

  it('leaves the key unknown, naming the file, when a path argument cannot be read', async () => {
    const directory = makeDirectory();
    const binary = placed(path.join(directory, 'loom'), '#!/bin/sh\n');
    const weights = path.join(placed(path.join(directory, 'plain-file'), 'x'), 'weights.gguf');
    const description = declaredWith(['--model', weights, '{socket}'], binary);

    const key = await keyOf(description, binary);

    expect(key).toMatchObject({ kind: 'unknown', component: fileIdentityComponentOf(weights) });
    expect((key as { reason: string }).reason).toContain(weights);
  });
});
