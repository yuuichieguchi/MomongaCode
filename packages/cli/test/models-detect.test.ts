import { describe, expect, it } from 'vitest';
import { providerNameOf } from '@momonga/config';
import { IDENTITY_READ_TIMEOUT_MS } from '@momonga/gateway';
import { FM_SERVER, LOCAL_SERVER_CANDIDATES, SERVER_KINDS } from '@momonga/protocol';
import { detectModels, serversDetector } from '../src/commands/models.ts';
import type { ModelsShell } from '../src/commands/models.ts';
import type { CliPorts } from '../src/ports.ts';
import { freshHome } from './fresh-home.ts';

const shellOf = (written: string[], fetchFn: typeof fetch): ModelsShell => {
  const home = freshHome();
  const ports = {
    home,
    exec: async (_file: string, args: readonly string[]) => (args.join(' ') === 'license --status' ? { exitCode: 69, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    files: { exists: async (file: string) => file === FM_SERVER.binary.defaultPath },
  } as unknown as CliPorts;
  return { stdout: { write: (text: string) => void written.push(text) }, home, interrupt: new AbortController().signal, detect: serversDetector(ports, fetchFn) } as unknown as ModelsShell;
};

const answering = (routes: Readonly<Record<string, unknown>>): { fetch: typeof fetch; asked: string[] } => {
  const asked: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    const body = routes[url];
    if (body !== undefined) return new Response(JSON.stringify(body), { status: 200 });
    if (Object.keys(routes).some((served) => new URL(served).origin === new URL(url).origin)) return new Response('not found', { status: 404 });
    throw new TypeError(`fetch failed: ${url}`);
  };
  return { fetch: fetchFn as typeof fetch, asked };
};

const READS_PER_ADDRESS = 2;
const DETECT_TIMEOUT_MS = IDENTITY_READ_TIMEOUT_MS * READS_PER_ADDRESS * LOCAL_SERVER_CANDIDATES.length;

const [FIRST_CANDIDATE] = LOCAL_SERVER_CANDIDATES;
const SERVED_AT = `${FIRST_CANDIDATE}/v1`;
const SERVED_NAME = providerNameOf({ adapter: 'chat-completions', baseUrl: SERVED_AT }, SERVER_KINDS);

describe('momonga models detect', { timeout: DETECT_TIMEOUT_MS }, () => {
  it('asks every shipped candidate and prints what answered without writing anything', async () => {
    const written: string[] = [];
    const served = answering({ [`${FIRST_CANDIDATE}/v1/models`]: { data: [{ id: 'served' }] } });

    const code = await detectModels(shellOf(written, served.fetch), { typed: [], json: false });

    expect(code).toBe(0);
    expect(written.join('').split('\n').slice(0, 2)).toEqual([`${SERVED_NAME}  ·  ${SERVED_AT}`, '  served']);
    expect(served.asked.some((url) => url.startsWith(LOCAL_SERVER_CANDIDATES[1] as string))).toBe(true);
  });

  it('prints the servers that answered as JSON in the settled shape, without the managed servers the text lists', async () => {
    const written: string[] = [];
    const served = answering({ [`${FIRST_CANDIDATE}/v1/models`]: { data: [{ id: 'served' }] } });

    await detectModels(shellOf(written, served.fetch), { typed: [], json: true });

    expect(JSON.parse(written.join(''))).toEqual({
      servers: [{ kind: 'generic', provider: SERVED_NAME, address: SERVED_AT, models: [{ id: 'served', tools: 'unknown' }] }],
    });
  });
});
