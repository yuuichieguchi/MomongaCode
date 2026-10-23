export const SOCKET_PATH_LIMIT = 104;

export const assertSocketPathLength = (socketPath: string): void => {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength >= SOCKET_PATH_LIMIT) {
    throw new Error(
      `Unix socket path ${socketPath} is ${byteLength} bytes; it must be shorter than ${SOCKET_PATH_LIMIT} bytes. Use a shorter path.`,
    );
  }
};
