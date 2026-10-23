import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeBuiltins, resultOf } from './fixtures.ts';

describe('Write through a dangling link whose target has dotdot after a symlink', () => {
  it('writes where the kernel resolves the link and nowhere else', async () => {
    const tools = await makeBuiltins();
    const project = tools.layout.project;
    fs.mkdirSync(path.join(project, 'a', 'b'), { recursive: true });
    fs.symlinkSync(path.join(project, 'a', 'b'), path.join(project, 's'));
    fs.symlinkSync('s/../f', path.join(project, 'link'));
    const result = resultOf(await tools.run('Write', { file_path: path.join(project, 'link'), content: 'payload' }, { mode: 'acceptEdits', roots: [project] }));
    expect(result.status).toBe('completed');
    expect(fs.existsSync(path.join(project, 'f'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'a', 'f'), 'utf8')).toBe('payload');
  });
});
