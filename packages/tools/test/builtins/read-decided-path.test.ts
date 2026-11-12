import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeBuiltins, resultOf } from './fixtures.ts';

const SECRET = 'the secret outside the roots';

describe('Read acts on the file the permission decision was made for', () => {
  it('refuses when the file is swapped for a link to a file outside the roots between the decision and the read', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('notes.txt', 'plain notes\n');
    const secret = path.join(tools.layout.outside, 'secret.txt');
    fs.writeFileSync(secret, `${SECRET}\n`);
    const swap = (): void => {
      fs.rmSync(file);
      fs.symlinkSync(secret, file);
    };
    const result = resultOf(await tools.run('Read', { file_path: file }, { onStarted: swap }));
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain(SECRET);
  });

  it('reads the decided file when nothing changed', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('notes.txt', 'plain notes\n');
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.status).toBe('completed');
    expect(result.output).toContain('plain notes');
  });
});
