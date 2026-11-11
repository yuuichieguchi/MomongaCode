import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { serveAcp } from '../src/acp/serve.ts';
import type { CliPorts } from '../src/ports.ts';

describe('serveAcp', () => {
  it('closes the connection and returns when the interrupt came before the connection opened', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const input = { take: () => undefined, arrival: () => new Promise<'bytes' | 'end'>(() => undefined) };
    const output = new WritableStream<Uint8Array>();
    const ports = { acpStdio: () => ({ input, output }), version: '1.2.3' } as unknown as CliPorts;
    const interrupt = new AbortController();
    interrupt.abort();

    await expect(serveAcp(ports, paths, interrupt.signal)).resolves.toBe(0);
  });
});
