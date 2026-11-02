export type StreamErrors = { assertHealthy(): void };

export const trackStreamErrors = (stream: NodeJS.EventEmitter, label: string): StreamErrors => {
  const errors: Error[] = [];
  stream.on('error', (error: Error) => void errors.push(error));
  return {
    assertHealthy: () => {
      if (errors.length > 0) throw new AggregateError(errors, `${label} failed`);
    },
  };
};
