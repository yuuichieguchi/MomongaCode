import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { IDENTITY_READ_TIMEOUT_MS } from '@momonga/gateway';
import { FM_SERVER, LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';
import { detectModels } from '../src/commands/models.ts';
import type { CliPorts } from '../src/ports.ts';
import { freshHome } from './fresh-home.ts';

const READS_PER_ADDRESS = 2;
const DETECT_TIMEOUT_MS = IDENTITY_READ_TIMEOUT_MS * READS_PER_ADDRESS * LOCAL_SERVER_CANDIDATES.length;

const nothingAnswers = (async (input: string | URL | Request) => {
  throw new TypeError(`fetch failed: ${String(input)}`);
}) as typeof fetch;

describe('momonga models detect takes the host program runner and the file check from its ports (P-C11)', { timeout: DETECT_TIMEOUT_MS }, () => {
  it('runs the precondition of a shipped managed server through ports.exec and finds its binary through ports.files.exists', async () => {
    const written: string[] = [];
    const asked: string[] = [];
    const ports = {
      stdout: { write: (text: string) => void written.push(text) },
      exec: async (_file: string, args: readonly string[]) => {
        asked.push(args.join(' '));
        return args.join(' ') === 'license --status' ? { exitCode: 69, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' };
      },
      files: { exists: async (file: string) => file === FM_SERVER.binary.defaultPath },
    } as unknown as CliPorts;

    const code = await detectModels(ports, momongaLayout(freshHome()), { typed: [], json: false, interrupt: new AbortController().signal, fetch: nothingAnswers });

    expect(code).toBe(0);
    const lines = written.join('').split('\n');
    const found = lines.indexOf(`found the managed server fm at ${FM_SERVER.binary.defaultPath}`);
    expect(found).toBeGreaterThan(-1);
    expect(lines[found + 1]).toBe('  the Apple Foundation Models licence has not been accepted (sudo fm license)');
    expect(asked).toContain('license --status');
  });
});
