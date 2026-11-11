import { duplexPair } from 'node:stream';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RELAY_CHANNEL_SLOT, SOCKET_GUARD_CHANNEL_SLOT, relayCommandOf, relayInside, serveRelayChannel } from '@momonga/sandbox';

const received = (stream: Duplex): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });

const wired = (): { accept: (socket: Duplex) => void; proxySides: Duplex[]; relayHeld: Duplex[] } => {
  const [insideChannel, hostChannel] = duplexPair();
  const proxySides: Duplex[] = [];
  const relayHeld: Duplex[] = [];
  serveRelayChannel(hostChannel, () => {
    const [toProxy, proxySide] = duplexPair();
    proxySides.push(proxySide);
    relayHeld.push(toProxy);
    return toProxy;
  });
  const inside = relayInside(insideChannel);
  return { accept: (socket) => inside.accept(socket), proxySides, relayHeld };
};

describe('the network relay over one inherited channel', () => {
  it('carries the bytes of a connection to the proxy and the answer back, and the end of each side', async () => {
    const { accept, proxySides } = wired();
    const [command, relaySide] = duplexPair();
    accept(relaySide);
    command.end('GET http://granted.test/ HTTP/1.1\r\n\r\n');
    await expect.poll(() => proxySides.length).toBe(1);
    const proxy = proxySides[0] as Duplex;
    const request = received(proxy);
    const answer = received(command);
    expect(await request).toBe('GET http://granted.test/ HTTP/1.1\r\n\r\n');
    proxy.end('HTTP/1.1 200 OK\r\n\r\nhi');
    expect(await answer).toBe('HTTP/1.1 200 OK\r\n\r\nhi');
  });

  it('keeps two connections apart', async () => {
    const { accept, proxySides } = wired();
    const [first, firstRelay] = duplexPair();
    const [second, secondRelay] = duplexPair();
    accept(firstRelay);
    accept(secondRelay);
    first.end('one');
    second.end('two');
    await expect.poll(() => proxySides.length).toBe(2);
    expect((await Promise.all(proxySides.map(received))).sort()).toEqual(['one', 'two']);
  });

  it('closes the command side when the connection to the proxy closes', async () => {
    const { accept, proxySides, relayHeld } = wired();
    const [command, relaySide] = duplexPair();
    accept(relaySide);
    command.write('x');
    await expect.poll(() => proxySides.length).toBe(1);
    const closed = new Promise<void>((resolve) => relaySide.on('close', () => resolve()));
    (relayHeld[0] as Duplex).destroy();
    await closed;
  });
});

describe('the relay command', () => {
  it('puts the relay before the command with its channel, the port and the marker slot', () => {
    expect(RELAY_CHANNEL_SLOT).toBe(SOCKET_GUARD_CHANNEL_SLOT + 1);
    expect(relayCommandOf(['/opt/momonga', '__helper', 'network-relay'], 41234, 3, ['/bin/sh', '-c', 'true'])).toEqual([
      '/opt/momonga', '__helper', 'network-relay', String(RELAY_CHANNEL_SLOT), '41234', '3', '--', '/bin/sh', '-c', 'true',
    ]);
    expect(relayCommandOf(['/opt/momonga', '__helper', 'network-relay'], 41234, undefined, ['true'])).toEqual([
      '/opt/momonga', '__helper', 'network-relay', String(RELAY_CHANNEL_SLOT), '41234', '-', '--', 'true',
    ]);
  });
});
