export type Pausable = { readonly isPaused: boolean; pause(): void; resume(): void };

export type InboundQueue = {
  push(text: string): void;
  shift(): string | undefined;
  discard(): void;
};

export const createInboundQueue = (socket: Pausable, maxBytes: number): InboundQueue => {
  const entries: Array<{ text: string; bytes: number }> = [];
  let queuedBytes = 0;

  const resumeWhenRoom = (): void => {
    if (queuedBytes < maxBytes && socket.isPaused) socket.resume();
  };

  return {
    push: (text) => {
      const bytes = Buffer.byteLength(text);
      entries.push({ text, bytes });
      queuedBytes += bytes;
      if (queuedBytes >= maxBytes) socket.pause();
    },
    shift: () => {
      const next = entries.shift();
      if (next === undefined) return undefined;
      queuedBytes -= next.bytes;
      resumeWhenRoom();
      return next.text;
    },
    discard: () => {
      entries.length = 0;
      queuedBytes = 0;
      resumeWhenRoom();
    },
  };
};
