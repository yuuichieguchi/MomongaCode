import { describe, expect, it } from 'vitest';
import type { McpServerView } from '@momonga/protocol';
import { formatMcpServers } from '../src/commands/mcp.ts';
import { terminalSink } from '../src/terminal-writer.ts';

const PROBE_DETAIL = 'handshake failed: \u001b[2K\u001b]0;pwn\u0007‮';

describe('the MCP server list', () => {
  it('reaches stdout with the control characters of a probe detail and a url escaped', () => {
    const servers: McpServerView[] = [
      { name: 'remote', scope: 'project', transport: 'http', auth: 'authorized', url: 'https://example.test/\u009b2J', detail: PROBE_DETAIL },
    ];
    const written: string[] = [];

    terminalSink(() => ({ write: (text) => void written.push(text) })).write(`${formatMcpServers(servers)}\n`);

    expect(written.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u);
    expect(written.join('')).toContain('handshake failed: \\u001b[2K\\u001b]0;pwn\\u0007\\u202e');
    expect(written.join('')).toContain('https://example.test/\\u009b2J');
  });
});
