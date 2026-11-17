import { describe, expect, it, vi } from 'vitest';
import * as config from '@momonga/config';
import { loadUserSettings } from '@momonga/config';
import * as protocol from '@momonga/protocol';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { seeded } from '../../context/test/helpers.ts';
import { CAPABILITIES, chatConnection } from './model-fixtures.ts';
import { loadModelsSection, refusalOf } from './load-models.ts';
import { editModels, homeWith, op, textOf } from './models-edit.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

type Random = ReturnType<typeof seeded>;
type Connection = { provider?: string; adapter: string; baseUrl?: string; socketPath?: string };

const SEEDS = 200;
const FILE_SEEDS = 40;
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/;
const ADAPTERS = ['chat-completions', 'open-responses', 'ollama'] as const;
const LABEL_HEAD = 'abcdefghijklmnopqrstuvwxyz';
const LABEL_TAIL = `${LABEL_HEAD}0123456789-`;
const SOCKET_CHARACTERS = 'ABCxyz019 _.-';
const IPV6_HOSTS = ['::1', 'fe80::1', '2001:db8::7', '2001:db8:0:1::a', 'fd00::abcd:1'] as const;

const providerNameOf = (connection: Connection): string => {
  const derive = (config as Record<string, unknown>)['providerNameOf'];
  const kinds = (protocol as Record<string, unknown>)['SERVER_KINDS'];
  if (typeof derive !== 'function') throw new Error('@momonga/config does not export providerNameOf (packages/config/src/provider-name.ts)');
  if (kinds === undefined) throw new Error('@momonga/protocol does not export SERVER_KINDS (packages/protocol/src/server-kinds.ts)');
  return (derive as (connection: Connection, kinds: unknown) => string)(connection, kinds);
};

const pick = <T>(random: Random, items: readonly T[]): T => items[random.int(0, items.length - 1)] as T;

const textOver = (random: Random, alphabet: string, length: number): string => Array.from({ length }, () => alphabet[random.int(0, alphabet.length - 1)] as string).join('');

const labelOf = (random: Random): string => `${textOver(random, LABEL_HEAD, 1)}${textOver(random, LABEL_TAIL, random.int(0, 6))}${textOver(random, LABEL_HEAD, 1)}`.replaceAll('--', '-a');

const dnsHostOf = (random: Random): string => Array.from({ length: random.int(1, 3) }, () => labelOf(random)).join('.');

const ipv4Of = (random: Random): string => Array.from({ length: 4 }, () => String(random.int(1, 254))).join('.');

const hostOf = (random: Random): string => (random.int(0, 2) === 0 ? ipv4Of(random) : dnsHostOf(random));

const portOf = (random: Random): number => random.int(1, 65535);

const socketOf = (random: Random): string => `/${Array.from({ length: random.int(1, 3) }, () => textOver(random, SOCKET_CHARACTERS, random.int(1, 40)).replaceAll('/', '-')).join('/')}`;

const connectionOf = (random: Random): Connection => {
  const adapter = pick(random, ADAPTERS);
  const kind = random.int(0, 3);
  if (kind === 0) return { adapter, socketPath: socketOf(random) };
  if (kind === 1) return { adapter, baseUrl: `http://[${pick(random, IPV6_HOSTS)}]:${portOf(random)}` };
  return { adapter, baseUrl: `${pick(random, ['http', 'https'])}://${hostOf(random)}:${portOf(random)}/v1` };
};

describe('the server name derived from a connection (I-N11)', () => {
  it(
    'always matches the pattern of a server name',
    () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const connection = connectionOf(seeded(seed));
        expect(providerNameOf(connection), `seed ${seed} ${JSON.stringify(connection)}`).toMatch(NAME_PATTERN);
      }
    },
  );

  it(
    'depends only on the fields of its own connection: the same connection has the same name alone and beside any other, in any order',
    async () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const connection = connectionOf(seeded(seed));
        expect(providerNameOf({ ...connection }), `seed ${seed}`).toBe(providerNameOf(connection));
      }
      for (let seed = 1; seed <= FILE_SEEDS; seed += 1) {
        const random = seeded(seed);
        const first = chatConnection(`https://${dnsHostOf(random)}.example.com:${portOf(random)}/v1`, ['m']);
        const second = chatConnection(`https://${dnsHostOf(random)}.example.org:${portOf(random)}/v1`, ['n']);
        const alone = [...(await loadModelsSection({ connections: [first] })).models.models.keys()];
        const beside = [...(await loadModelsSection({ connections: [second, first] })).models.models.keys()];
        expect(alone, `seed ${seed}`).toEqual([`${providerNameOf(first as Connection)}/m`]);
        expect(beside, `seed ${seed}`).toEqual([`${providerNameOf(second as Connection)}/n`, alone[0]]);
      }
    },
  );

  it(
    'two different addresses of plain hosts, and two different socket paths, never share a name; hosts with other characters share one only where the loader refuses the file',
    async () => {
      const named = new Map<string, string>();
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const random = seeded(seed);
        const address = `${hostOf(random)}:${portOf(random)}`;
        const socketPath = socketOf(random);
        for (const [identity, connection] of [
          [`address ${address}`, { adapter: 'chat-completions', baseUrl: `http://${address}/v1` }],
          [`socket ${socketPath}`, { adapter: 'chat-completions', socketPath }],
        ] as const) {
          const name = providerNameOf(connection);
          expect(named.get(name) ?? identity, `seed ${seed} ${name}`).toBe(identity);
          named.set(name, identity);
        }
      }
      for (let seed = 1; seed <= FILE_SEEDS; seed += 1) {
        const random = seeded(seed);
        const port = portOf(random);
        const plain = `${labelOf(random)}-${labelOf(random)}`;
        const other = random.int(0, 1) === 0 ? plain.replace('-', '_') : `${labelOf(random)}_${labelOf(random)}`;
        const connections = [chatConnection(`http://${plain}:${port}/v1`, ['m']), chatConnection(`http://${other}:${port}/v1`, ['n'])];
        const [left, right] = connections.map((connection) => providerNameOf(connection as Connection));
        if (left === right) {
          const { file, message } = await refusalOf({ models: { connections } });
          expect(message, `seed ${seed}`).toBe(`${file}: models.connections[0] and models.connections[1] both resolve to the server name "${left as string}"; write "provider" on one of them`);
        } else {
          expect([...(await loadModelsSection({ connections })).models.models.keys()], `seed ${seed}`).toEqual([`${left as string}/m`, `${right as string}/n`]);
        }
      }
    },
  );

  it(
    'every file the writer produces from generated choices loads: a choice that would give one name twice is refused and nothing is written',
    async () => {
      let added = 0;
      for (let seed = 1; seed <= FILE_SEEDS; seed += 1) {
        const random = seeded(seed);
        const home = homeWith({});
        for (let count = random.int(2, 5); count > 0; count -= 1) {
          const host = pick(random, ['my-host', 'my_host', 'other.example.com', '127.0.0.1', 'localhost']);
          const connection = { adapter: pick(random, ADAPTERS), baseUrl: `http://${host}:${pick(random, [8080, 11434])}${pick(random, ['', '/v1', '/a'])}` };
          const before = textOf(home);
          const accepted = await editModels(home, [op('addModel', { choice: { connection, model: { id: `m${count}`, capabilities: CAPABILITIES } } })]).then(
            () => true,
            () => false,
          );
          if (accepted) added += 1;
          else expect(textOf(home), `seed ${seed}`).toBe(before);
          const views = ((await loadUserSettings({ env: process.env, home: home.tree.home, signal: new AbortController().signal })).settings.models as unknown as { views: readonly { provider: string; canon: string }[] }).views;
          expect(new Set(views.map((view) => view.canon)).size, `seed ${seed}`).toBe(views.length);
        }
      }
      expect(added).toBeGreaterThan(FILE_SEEDS);
    },
  );
});
