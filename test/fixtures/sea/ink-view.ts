import { PassThrough } from 'node:stream';
import { Text, render } from 'ink';
import { createElement } from 'react';

class CapturedStdout extends PassThrough {
  readonly columns = 80;
  readonly isTTY = false;
}

export const renderInk = async (): Promise<string> => {
  const stdout = new CapturedStdout();
  const chunks: string[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const instance = render(createElement(Text, null, 'ink-rendered'), { stdout: stdout as never, debug: true, patchConsole: false });
  instance.unmount();
  await instance.waitUntilExit();
  return `ink output=${chunks.join('').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()}`;
};
