import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relative: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', relative), 'utf8');

const SIBLINGS = ['commands/report.ts', 'commands/trace.ts', 'commands/cost.ts'];

describe('the sibling commands share one entry rule (cli-commands-C42)', () => {
  it.each(SIBLINGS)('%s ensures the daemon through ensureCurrentDaemon, never the older ensureDaemon', (file) => {
    const text = source(file);
    expect(text).toMatch(/\bensureCurrentDaemon\(/);
    expect(text).not.toMatch(/\bensureDaemon\(/);
  });

  it('the ACP agent module keeps no entry that nothing calls (createAcpAgent)', () => {
    expect(source('acp/agent.ts')).not.toMatch(/\bcreateAcpAgent\b/);
  });
});
