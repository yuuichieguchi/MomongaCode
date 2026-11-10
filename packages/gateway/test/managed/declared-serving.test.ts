import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, momongaPaths, socketPathLimit } from '@momonga/foundation';
import { loadUserSettings, probeKeyOf } from '@momonga/config';
import type { KnownProbeKey } from '@momonga/config';
import { managedCurrencyOf, saveProbeRecord } from '@momonga/gateway';
import { FM_SERVER } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeFm, createFakeManagedServer, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, until, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';
import { makeReport } from '../report-fixture.ts';
import { registryOf } from './declared-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type DumpRecord = { argv: string[]; pid: number };

const DECLARED_BOUNDS = { capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };

const readDump = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
    : [];

const sha256OfFile = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const ask = () => ({ model: 'default', input: userInput('hello') });

const targetsDir = (home: string): string => path.join(momongaPaths(home, process.platform, {}).run, `g${FIRST_GENERATION}`, 'targets');
const targetMarkers = (home: string, stem: string): string => path.join(momongaPaths(home, process.platform, {}).markers.root, `g${FIRST_GENERATION}`, 'targets', stem);
const probeDir = (home: string): string => momongaPaths(home, process.platform, {}).probe;
const recordFiles = (home: string): string[] => (fs.existsSync(probeDir(home)) ? fs.readdirSync(probeDir(home)).filter((name) => name.endsWith('.json')).sort() : []);

const launch = (home: string) => launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec } as GatewayProcessOptions);

type Kind = {
  label: string;
  target: string;
  server: string;
  serveCommand: string;
  model: string;
  prepare(dir: string): Promise<{ binary: string; dumpFile: string }>;
  settings(binary: string, target: Record<string, unknown>): Record<string, unknown>;
};

const KINDS: Kind[] = [
  {
    label: 'a server declared in the user settings (the fake launcher, never tested as fm)',
    target: 'workbench',
    server: 'loom',
    serveCommand: 'run',
    model: 'fake-1',
    prepare: async (dir) => {
      const fake = await createFakeManagedServer({ dir });
      const dumpFile = path.join(dir, 'argv.jsonl');
      fake.configure({ envDumpFile: dumpFile });
      return { binary: fake.binaryPath, dumpFile };
    },
    settings: (binary, target) => ({
      models: {
        servers: { loom: { command: binary, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
        targets: { workbench: { adapter: 'managed', server: 'loom', model: 'fake-1', ...target } },
        aliases: { default: ['workbench'] },
      },
    }),
  },
  {
    label: 'the built-in fm',
    target: 'apple',
    server: FM_SERVER.id,
    serveCommand: 'serve',
    model: 'system',
    prepare: async (dir) => {
      const fm = await createFakeFm({ dir });
      const dumpFile = path.join(dir, 'argv.jsonl');
      fm.configure({ envDumpFile: dumpFile });
      return { binary: fm.binaryPath, dumpFile };
    },
    settings: (binary, target) => ({
      models: { targets: { apple: { adapter: 'managed', server: FM_SERVER.id, binary, model: 'system', ...target } }, aliases: { default: ['apple'] } },
    }),
  },
];

const descriptionIn = async (home: string, id: string): Promise<ManagedServerDescription> => {
  if (id === FM_SERVER.id) return FM_SERVER;
  const { settings } = await loadUserSettings({ home });
  const found = registryOf(settings.models).find((server) => server.id === id);
  if (found === undefined) throw new Error(`the loaded registry has no server ${JSON.stringify(id)}`);
  return found;
};

const keyOf = (description: ManagedServerDescription, binary: string, model: string): KnownProbeKey => {
  const key = probeKeyOf({
    subject: description.id,
    identity: description.identity,
    readings: { binarySha256: { kind: 'read', value: sha256OfFile(binary) }, hostOsBuild: { kind: 'read', value: FAKE_OS_BUILD } },
    model,
  });
  if (key.kind !== 'known') throw new Error('a key built from read components is known');
  return key;
};

const served = async (kind: Kind, target: Record<string, unknown> = {}) => {
  const dir = makeDir();
  const { binary, dumpFile } = await kind.prepare(dir);
  registerCleanup(() => killGroupsForCleanup(readDump(dumpFile).map((record) => record.pid)));
  const home = makeHome();
  writeSettings(home, kind.settings(binary, { toolCalling: 'auto', ...target }));
  const description = await descriptionIn(home, kind.server);
  const saveRecord = async (): Promise<KnownProbeKey> => {
    const key = keyOf(description, binary, kind.model);
    await saveProbeRecord(probeDir(home), key, makeReport(1, 1), managedCurrencyOf(description, { userDialects: {} }));
    return key;
  };
  return { dir, binary, dumpFile, home, description, saveRecord };
};

const serves = (dumpFile: string, command: string): DumpRecord[] => readDump(dumpFile).filter((record) => record.argv[0] === command);

describe.each(KINDS)('one mechanism serves $label with the five assertions of section 13.2 (design-managed-servers 19.8; R-S19-10, R-S19-24)', (kind) => {
  it('starts and answers a request with no managedServers port, launched on run/g<N>/targets/<target>-<k>.sock', async () => {
    const { home, dumpFile, saveRecord } = await served(kind);
    await saveRecord();
    const handle = await launch(home);
    expect((await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()))).status).toBe(200);
    const runs = serves(dumpFile, kind.serveCommand);
    expect(runs).toHaveLength(1);
    const argv = (runs[0] as DumpRecord).argv;
    expect(argv[argv.indexOf('--socket') + 1]).toBe(path.join(targetsDir(home), `${kind.target}-1.sock`));
  });

  it('refuses with 412 and the row-0 text when the executable is missing, before any launch', async () => {
    const { home, binary, dumpFile, saveRecord } = await served(kind);
    await saveRecord();
    const handle = await launch(home);
    fs.rmSync(binary);
    const answered = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()));
    expect(answered.status).toBe(412);
    const text = JSON.stringify(answered.body);
    expect(text).toContain(`the target \\"${kind.target}\\" is not ready: the executable is missing`);
    expect(text).toContain(`the target \\"${kind.target}\\": the executable was not found at ${binary}`);
    expect(serves(dumpFile, kind.serveCommand)).toEqual([]);
  });

  it('probes with no record: 503 with retry-after, a record named by the key digest holding the description digest and the binary hash, and a new record after the binary changes', async () => {
    const { home, binary, description } = await served(kind);
    const handle = await launch(home);
    const client = clientFor(handle.socketPath);
    const first = await postJson(client, '/v1/responses', ask());
    expect(first.status).toBe(503);
    expect(first.headers['retry-after']).toBeDefined();
    const key = keyOf(description, binary, kind.model);
    await until(() => recordFiles(home).includes(`${key.digest}.json`), 'the probe record of the start key');
    const stored = fs.readFileSync(path.join(probeDir(home), `${key.digest}.json`), 'utf8');
    expect(stored).toContain(managedCurrencyOf(description, { userDialects: {} }).descriptionDigest);
    expect(stored).toContain(sha256OfFile(binary));
    await handle.close();
    fs.appendFileSync(binary, '\n');
    const again = await launch(home);
    expect((await postJson(clientFor(again.socketPath), '/v1/responses', ask())).status).toBe(503);
    const changed = keyOf(description, binary, kind.model);
    await until(() => recordFiles(home).includes(`${changed.digest}.json`), 'the probe record of the changed binary');
    expect(changed.digest).not.toBe(key.digest);
  });

  it('restarts a child killed with SIGKILL, and the next request is answered', async () => {
    const { home, dumpFile, saveRecord } = await served(kind);
    await saveRecord();
    const handle = await launch(home);
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', ask()))).status).toBe(200);
    const first = serves(dumpFile, kind.serveCommand)[0] as DumpRecord;
    process.kill(first.pid, 'SIGKILL');
    await until(() => !isAlive(first.pid), 'the killed child to end');
    expect((await readJson(await postJson(client, '/v1/responses', ask()))).status).toBe(200);
    expect(serves(dumpFile, kind.serveCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('leaves no child alive and an empty marker directory after the gateway closes', async () => {
    const { home, dumpFile, saveRecord } = await served(kind);
    await saveRecord();
    const handle = await launch(home);
    expect((await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()))).status).toBe(200);
    await handle.close();
    for (const record of serves(dumpFile, kind.serveCommand)) expect(isAlive(record.pid)).toBe(false);
    expect(fs.readdirSync(targetMarkers(home, `${kind.target}-1`))).toEqual([]);
  });
});

describe('a declared server whose command is missing answers the row-0 text, not a placeholder (19.4; R-S19-17)', () => {
  it('answers 412 naming the declared path', async () => {
    const home = makeHome();
    const missing = path.join(makeDir(), 'absent-server');
    writeSettings(home, {
      models: {
        servers: { loom: { command: missing, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
        targets: { workbench: { adapter: 'managed', server: 'loom', model: 'fake-1', toolCalling: 'auto' } },
        aliases: { default: ['workbench'] },
      },
    });
    const handle = await launch(home);
    const answered = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()));
    expect(answered.status).toBe(412);
    expect(JSON.stringify(answered.body)).toContain(`the target \\"workbench\\": the executable was not found at ${missing}`);
  });
});

describe.skipIf(process.platform === 'win32')('a declared server socket path too long for the platform refuses that target only (18.2.5; R-S19-18)', () => {
  it('answers 412 with the bind-measurement text and creates no marker directory or socket for the instance', async () => {
    const fake = await createFakeManagedServer({ dir: makeDir() });
    const home = makeHome();
    const limit = socketPathLimit(process.platform);
    const prefix = Buffer.byteLength(path.join(targetsDir(home), 'x-1.sock')) - 1;
    const name = `t${'n'.repeat(limit + 1 - prefix - 1)}`;
    const socket = path.join(targetsDir(home), `${name}-1.sock`);
    expect(Buffer.byteLength(socket)).toBe(limit + 1);
    writeSettings(home, {
      models: {
        servers: { loom: { command: fake.binaryPath, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
        targets: { [name]: { adapter: 'managed', server: 'loom', model: 'fake-1', ...DECLARED_BOUNDS, toolCalling: 'auto' } },
        aliases: { default: [name] },
      },
    });
    const description = await descriptionIn(home, 'loom');
    await saveProbeRecord(probeDir(home), keyOf(description, fake.binaryPath, 'fake-1'), makeReport(1, 1), managedCurrencyOf(description, { userDialects: {} }));
    const handle = await launch(home);
    const answered = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()));
    expect(answered.status).toBe(412);
    expect(answered.body.error.message).toContain(`the target "${name}": its server socket path is ${limit + 1} bytes, and the system refused to bind a socket path of that length in ${path.dirname(socket)} (`);
    expect(answered.body.error.message).toMatch(/\((ENAMETOOLONG|EINVAL)\); choose a shorter target name/);
    expect(fs.existsSync(targetMarkers(home, `${name}-1`))).toBe(false);
    expect(fs.existsSync(socket)).toBe(false);
  });
});

const declaredFake = async () => {
  const dir = makeDir();
  const fake = await createFakeManagedServer({ dir });
  const dumpFile = path.join(dir, 'argv.jsonl');
  fake.configure({ envDumpFile: dumpFile });
  registerCleanup(() => killGroupsForCleanup(readDump(dumpFile).map((record) => record.pid)));
  const home = makeHome();
  writeSettings(home, {
    models: {
      servers: { bench: { command: fake.binaryPath, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
      targets: { workbench: { adapter: 'managed', server: 'bench', model: 'fake-1', toolCalling: 'auto' } },
      aliases: { default: ['workbench'] },
    },
  });
  return { binary: fake.binaryPath, dumpFile, home, description: await descriptionIn(home, 'bench') };
};

describe('the probe of a declared server records under the key of 19.4 on the instance places of 18.2.1 (R-S19-20)', () => {
  it('writes the record named by the digest of {subject, model, binarySha256, hostOsBuild}, probing on run/g<N>/targets/_probe-workbench.sock', async () => {
    const { binary, dumpFile, home, description } = await declaredFake();
    const handle = await launch(home);
    expect((await postJson(clientFor(handle.socketPath), '/v1/responses', ask())).status).toBe(503);
    const key = keyOf(description, binary, 'fake-1');
    expect(JSON.parse(key.canonical)).toEqual({ subject: 'bench', model: 'fake-1', binarySha256: sha256OfFile(binary), hostOsBuild: FAKE_OS_BUILD });
    await until(() => recordFiles(home).includes(`${key.digest}.json`), 'the probe record');
    const probeRuns = serves(dumpFile, 'run').map((record) => record.argv[record.argv.indexOf('--socket') + 1]);
    expect(probeRuns).toContain(path.join(targetsDir(home), '_probe-workbench.sock'));
    expect((await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()))).status).toBe(200);
    expect(serves(dumpFile, 'run').map((record) => record.argv[record.argv.indexOf('--socket') + 1])).toContain(path.join(targetsDir(home), 'workbench-1.sock'));
  });
});

describe('the running instance reads its record under the start key captured when its child started (19.11-a, 19.14 item 16b; R-S19-23)', () => {
  it('keeps answering from the start key record after the binary bytes change, and starts no probe of the new key', async () => {
    const { binary, home, description } = await declaredFake();
    const startKey = keyOf(description, binary, 'fake-1');
    await saveProbeRecord(probeDir(home), startKey, makeReport(1, 1), managedCurrencyOf(description, { userDialects: {} }));
    const handle = await launch(home);
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', ask()))).status).toBe(200);
    fs.appendFileSync(binary, '\n');
    expect((await readJson(await postJson(client, '/v1/responses', ask()))).status).toBe(200);
    expect(recordFiles(home)).toEqual([`${startKey.digest}.json`]);
  });

  it('runs the first child, and reads its record, under the key of the binary replaced after the gateway started and before that child started', async () => {
    const { binary, dumpFile, home, description } = await declaredFake();
    const keyAtGatewayStart = keyOf(description, binary, 'fake-1');
    const handle = await launch(home);
    expect(serves(dumpFile, 'run')).toEqual([]);
    fs.appendFileSync(binary, '\n');
    const keyAtChildStart = keyOf(description, binary, 'fake-1');
    expect(keyAtChildStart.digest).not.toBe(keyAtGatewayStart.digest);
    await saveProbeRecord(probeDir(home), keyAtChildStart, makeReport(1, 1), managedCurrencyOf(description, { userDialects: {} }));
    const answered = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', ask()));
    expect(answered.status).toBe(200);
    expect(serves(dumpFile, 'run').map((record) => record.argv[record.argv.indexOf('--socket') + 1])).toEqual([path.join(targetsDir(home), 'workbench-1.sock')]);
    expect(recordFiles(home)).toEqual([`${keyAtChildStart.digest}.json`]);
  });
});
