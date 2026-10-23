import { createStdioTransport } from '../../src/index.ts';

const [fixturePath, readyFile, projectDir] = process.argv.slice(2);
if (fixturePath === undefined || readyFile === undefined || projectDir === undefined) throw new Error('usage: host <fixture> <readyFile> <projectDir>');

const transport = createStdioTransport({
  name: 'escaped',
  config: { command: process.execPath, args: [fixturePath] },
  projectDir,
  baseEnv: { PATH: '/usr/bin:/bin' },
  closeGraceMs: 100,
});
transport.onclose = () => {
  process.stdout.write('closed\n');
};
transport.onerror = () => undefined;
await transport.start();
await transport.send({ jsonrpc: '2.0', id: 1, method: 'escape_grandchild', params: { readyFile } });
