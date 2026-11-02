import { describe, expect, it } from 'vitest';
import { createInboundQueue } from '../src/server/inbound-queue.ts';

const fakeSocket = () => {
  const socket = {
    isPaused: false,
    pause: () => {
      socket.isPaused = true;
    },
    resume: () => {
      socket.isPaused = false;
    },
  };
  return socket;
};

describe('the inbound queue of a WebSocket connection', () => {
  it('pauses the socket once the queued bytes reach the limit and resumes it when a shift makes room', () => {
    const socket = fakeSocket();
    const queue = createInboundQueue(socket, 10);
    queue.push('aaaaaa');
    expect(socket.isPaused).toBe(false);
    queue.push('bbbbbb');
    expect(socket.isPaused).toBe(true);
    expect(queue.shift()).toBe('aaaaaa');
    expect(socket.isPaused).toBe(false);
  });

  it('resumes a paused socket when the queue is discarded, so the close handshake can be read', () => {
    const socket = fakeSocket();
    const queue = createInboundQueue(socket, 10);
    queue.push('aaaaaa');
    queue.push('bbbbbb');
    expect(socket.isPaused).toBe(true);
    queue.discard();
    expect(socket.isPaused).toBe(false);
    expect(queue.shift()).toBeUndefined();
  });

  it('counts bytes, not characters', () => {
    const socket = fakeSocket();
    const queue = createInboundQueue(socket, 10);
    queue.push('あい');
    expect(socket.isPaused).toBe(false);
    queue.push('うa');
    expect(socket.isPaused).toBe(true);
  });
});
