import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import type { HelperHost } from '@momonga/foundation';
import { EGRESS_PROXY_HOST } from './egress-proxy.ts';
import { SOCKET_FILTER_SLOT } from './process.ts';

export const NETWORK_RELAY_HELPER = 'network-relay';

const SLOTS_AFTER_THE_SOCKET_FILTER = 2;

export const RELAY_CHANNEL_SLOT = SOCKET_FILTER_SLOT + SLOTS_AFTER_THE_SOCKET_FILTER;

const NO_MARKER = '-';

const RELAY_LISTEN_HOST = '127.0.0.1';

const FRAME_OPEN = 1;
const FRAME_DATA = 2;
const FRAME_END = 3;
const FRAME_CLOSE = 4;

const TYPE_AT = 0;
const ID_AT = 1;
const LENGTH_AT = 5;
const PAYLOAD_AT = LENGTH_AT + Uint32Array.BYTES_PER_ELEMENT;

const SIGNAL_EXIT_BASE = 128;

type Mux = { attach(id: number, socket: Duplex): void; open(socket: Duplex): void };

const frameOf = (type: number, id: number, payload: Uint8Array = new Uint8Array()): Buffer => {
  const header = Buffer.alloc(PAYLOAD_AT);
  header.writeUInt8(type, TYPE_AT);
  header.writeUInt32BE(id, ID_AT);
  header.writeUInt32BE(payload.length, LENGTH_AT);
  return Buffer.concat([header, payload]);
};

const muxOver = (channel: Duplex, onOpen: (id: number) => void): Mux => {
  const sockets = new Map<number, Duplex>();
  const send = (frame: Buffer): void => {
    if (!channel.writable) return;
    if (!channel.write(frame)) {
      for (const socket of sockets.values()) socket.pause();
    }
  };
  channel.on('drain', () => {
    for (const socket of sockets.values()) socket.resume();
  });
  let nextId = 1;
  const attach = (id: number, socket: Duplex): void => {
    sockets.set(id, socket);
    socket.on('data', (chunk: Buffer) => send(frameOf(FRAME_DATA, id, chunk)));
    socket.on('end', () => send(frameOf(FRAME_END, id)));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (sockets.delete(id)) send(frameOf(FRAME_CLOSE, id));
    });
    socket.on('drain', () => channel.resume());
  };
  let pending = Buffer.alloc(0);
  channel.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= PAYLOAD_AT) {
      const length = pending.readUInt32BE(LENGTH_AT);
      if (pending.length < PAYLOAD_AT + length) break;
      const type = pending.readUInt8(TYPE_AT);
      const id = pending.readUInt32BE(ID_AT);
      const payload = pending.subarray(PAYLOAD_AT, PAYLOAD_AT + length);
      pending = pending.subarray(PAYLOAD_AT + length);
      if (type === FRAME_OPEN) {
        onOpen(id);
        continue;
      }
      const socket = sockets.get(id);
      if (socket === undefined) continue;
      if (type === FRAME_DATA && !socket.write(payload)) channel.pause();
      if (type === FRAME_END) socket.end();
      if (type === FRAME_CLOSE) {
        sockets.delete(id);
        socket.destroy();
      }
    }
  });
  channel.on('close', () => {
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear();
  });
  return {
    attach,
    open: (socket) => {
      const id = nextId;
      nextId += 1;
      send(frameOf(FRAME_OPEN, id));
      attach(id, socket);
    },
  };
};

export function serveRelayChannel(channel: Duplex, connect: () => Duplex): void {
  const mux: Mux = muxOver(channel, (id) => mux.attach(id, connect()));
}

export const serveRelayToProxy = (channel: Duplex, port: number): void => serveRelayChannel(channel, () => net.connect(port, EGRESS_PROXY_HOST));

export function relayInside(channel: Duplex): { accept(socket: Duplex): void } {
  const mux = muxOver(channel, () => undefined);
  return { accept: (socket) => mux.open(socket) };
}

export const relayCommandOf = (relay: readonly string[], port: number, markerSlot: number | undefined, argv: readonly string[]): string[] => [
  ...relay,
  String(RELAY_CHANNEL_SLOT),
  String(port),
  markerSlot === undefined ? NO_MARKER : String(markerSlot),
  '--',
  ...argv,
];

const parseSlot = (text: string | undefined, what: string): number => {
  const value = Number(text);
  if (text === undefined || !Number.isInteger(value) || value < 0) throw new Error(`the network relay needs ${what} as a number, got ${String(text)}`);
  return value;
};

export async function runNetworkRelay(host: HelperHost): Promise<number> {
  const [channelText, portText, markerText, separator, file, ...args] = host.args;
  const channelSlot = parseSlot(channelText, 'its channel');
  const port = parseSlot(portText, 'the proxy port');
  const markerSlot = markerText === NO_MARKER ? undefined : parseSlot(markerText, 'the marker slot');
  if (separator !== '--' || file === undefined) throw new Error('the network relay needs -- and the command after its arguments');
  const channel = new net.Socket({ fd: channelSlot, readable: true, writable: true });
  const inside = relayInside(channel);
  const server = net.createServer((socket) => inside.accept(socket));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, RELAY_LISTEN_HOST, () => resolve());
  });
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(name, () => undefined);
  const passed: ('inherit' | 'ignore' | number)[] = ['inherit', 'inherit', 'inherit'];
  if (markerSlot !== undefined) {
    while (passed.length < markerSlot) passed.push('ignore');
    passed[markerSlot] = markerSlot;
  }
  const command = spawn(file, args, { stdio: passed, env: { ...host.env } });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    command.once('error', reject);
    command.once('exit', (code, signal) => resolve({ code, signal }));
  });
  server.close();
  channel.end();
  if (exit.code !== null) return exit.code;
  return SIGNAL_EXIT_BASE + (exit.signal === null ? 0 : os.constants.signals[exit.signal]);
}
