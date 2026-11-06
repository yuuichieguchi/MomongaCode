import { describe, expect, it } from 'vitest';
import type { MomongaPaths } from '@momonga/foundation';
import { LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';
import { detectModels, formatDetected } from '../src/commands/models.ts';
import type { CliPorts } from '../src/ports.ts';

const SETTINGS_FILE = '/home/u/.momonga/settings.json';

const portsOf = (written: string[]): CliPorts => ({ stdout: { write: (text: string) => void written.push(text) } }) as unknown as CliPorts;

const pathsOf = { settingsFile: SETTINGS_FILE } as unknown as MomongaPaths;

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

describe('momonga models detect', () => {
  it('asks every shipped candidate and prints what answered without writing anything', async () => {
    const written: string[] = [];
    const [first] = LOCAL_SERVER_CANDIDATES;
    const served = answering({ [`${first}/v1/models`]: { data: [{ id: 'served' }] } });

    const code = await detectModels(portsOf(written), pathsOf, { typed: [], json: false, interrupt: new AbortController().signal, fetch: served.fetch });

    expect(code).toBe(0);
    expect(written.join('')).toContain(`found at ${first} (openai API)`);
    expect(written.join('')).toContain('served  tools: unknown');
    expect(served.asked.some((url) => url.startsWith(LOCAL_SERVER_CANDIDATES[1] as string))).toBe(true);
  });

  it('says how to declare a target when nothing answered', () => {
    expect(formatDetected([], SETTINGS_FILE)).toContain(SETTINGS_FILE);
  });

  it('prints the servers as JSON', async () => {
    const written: string[] = [];
    const [first] = LOCAL_SERVER_CANDIDATES;
    const served = answering({ [`${first}/v1/models`]: { data: [{ id: 'served' }] } });

    await detectModels(portsOf(written), pathsOf, { typed: [], json: true, interrupt: new AbortController().signal, fetch: served.fetch });

    expect(JSON.parse(written.join(''))).toEqual([{ baseUrl: first, shape: 'openai', models: [{ id: 'served', tools: 'unknown' }] }]);
  });
});
