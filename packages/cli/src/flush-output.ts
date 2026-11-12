export type FlushedStream = { readonly writableLength: number; readonly destroyed: boolean; write(chunk: string, callback: (error?: Error | null) => void): boolean };

const flushed = (stream: FlushedStream): Promise<void> =>
  new Promise((resolve) => {
    if (stream.destroyed || stream.writableLength === 0) {
      resolve();
      return;
    }
    stream.write('', () => resolve());
  });

export const flushOutput = async (streams: readonly FlushedStream[]): Promise<void> => {
  await Promise.all(streams.map(flushed));
};
