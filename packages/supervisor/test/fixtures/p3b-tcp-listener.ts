import net from 'node:net';

const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : -1;
  process.stdout.write(`${JSON.stringify({ listening: port })}\n`);
});
