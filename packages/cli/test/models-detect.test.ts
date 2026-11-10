import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { IDENTITY_READ_TIMEOUT_MS } from '@momonga/gateway';
import { FM_SERVER, LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';
import { detectModels, formatDetected } from '../src/commands/models.ts';
import type { CliPorts } from '../src/ports.ts';
import { freshHome } from './fresh-home.ts';

const SETTINGS_FILE = '/home/u/.momonga/settings.json';

const pathsOf = (): MomongaPaths => momongaLayout(freshHome());

const portsOf = (written: string[]): CliPorts =>
  ({
    stdout: { write: (text: string) => void written.push(text) },
    exec: async (_file: string, args: readonly string[]) => (args.join(' ') === 'license --status' ? { exitCode: 69, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    files: { exists: async (file: string) => file === FM_SERVER.binary.defaultPath },
  }) as unknown as CliPorts;

const answering = (routes: Readonly<Record<string, unknown>>): { fetch: typeof fetch; asked: string[] } => {
  const asked: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    const body = routes[url];
    if (body === undefined) throw new TypeError(`fetch failed: ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: fetchFn as typeof fetch, asked };
};

const READS_PER_ADDRESS = 2;
const DETECT_TIMEOUT_MS = IDENTITY_READ_TIMEOUT_MS * READS_PER_ADDRESS * LOCAL_SERVER_CANDIDATES.length;

describe('momonga models detect', { timeout: DETECT_TIMEOUT_MS }, () => {
  it('asks every shipped candidate and prints what answered without writing anything', async () => {
    const written: string[] = [];
    const [first] = LOCAL_SERVER_CANDIDATES;
    const served = answering({ [`${first}/v1/models`]: { data: [{ id: 'served' }] } });

    const code = await detectModels(portsOf(written), pathsOf(), { typed: [], json: false, interrupt: new AbortController().signal, fetch: served.fetch });

    expect(code).toBe(0);
    expect(written.join('')).toContain(`found at ${first} (openai API)`);
    expect(written.join('')).toContain('served  tools: unknown');
    expect(served.asked.some((url) => url.startsWith(LOCAL_SERVER_CANDIDATES[1] as string))).toBe(true);
  });

  it('says how to declare a target when nothing answered', () => {
    expect(formatDetected([], SETTINGS_FILE)).toContain(SETTINGS_FILE);
  });

  it('prints the servers as JSON, the managed servers found on the host after the endpoints', async () => {
    const written: string[] = [];
    const [first] = LOCAL_SERVER_CANDIDATES;
    const served = answering({ [`${first}/v1/models`]: { data: [{ id: 'served' }] } });

    await detectModels(portsOf(written), pathsOf(), { typed: [], json: true, interrupt: new AbortController().signal, fetch: served.fetch });

    expect(JSON.parse(written.join(''))).toEqual([
      { baseUrl: first, shape: 'openai', models: [{ id: 'served', tools: 'unknown' }] },
      {
        shape: 'managed',
        id: 'fm',
        provider: 'apple',
        binary: '/usr/bin/fm',
        refused: { message: 'the Apple Foundation Models licence has not been accepted', remedy: 'sudo fm license' },
      },
    ]);
  });
});
