import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import { withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { detectModels, serversDetector } from '../src/commands/models.ts';
import type { ModelsShell } from '../src/commands/models.ts';
import type { CliPorts } from '../src/ports.ts';

const DECLARED_ID = 'workbench';

const shellOf = (written: string[], home: string, fetchFn: typeof fetch): ModelsShell => {
  const ports = {
    home,
    exec: async (file: string) => {
      throw new Error(`this test runs no host program; asked to run ${file}`);
    },
    files: { exists: async (file: string) => file !== FM_SERVER.binary.defaultPath && fs.existsSync(file) },
  } as unknown as CliPorts;
  return { stdout: { write: (text: string) => void written.push(text) }, home, interrupt: new AbortController().signal, detect: serversDetector(ports, fetchFn) } as unknown as ModelsShell;
};

const nothingAnswers = (async (input: string | URL | Request) => {
  throw new TypeError(`fetch failed: ${String(input)}`);
}) as typeof fetch;

const homeDeclaring = (context: CleanupContext, commandExists: boolean) => {
  const home = withTempDir(context, { asHome: true });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const command = path.join(bin, 'serve');
  if (commandExists) fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const paths = momongaLayout(home, process.platform, process.env);
  fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    paths.settingsFile,
    JSON.stringify({
      models: {
        servers: { [DECLARED_ID]: { command, args: ['{socket}'], readyPath: '/health' } },
        connections: [{ adapter: 'managed', server: DECLARED_ID, models: [{ id: 'bench-1' }] }],
      },
    }),
    { mode: 0o600 },
  );
  return { paths, command };
};

const detected = async (paths: ReturnType<typeof momongaLayout>, json: boolean): Promise<string> => {
  const written: string[] = [];
  const code = await detectModels(shellOf(written, paths.home, nothingAnswers), { typed: [], json });
  expect(code).toBe(0);
  return written.join('');
};

describe('O-R5-6 (E): momonga models detect lists the managed servers of the loaded settings, not only the shipped ones', () => {
  it('lists a declared server whose command exists as a managed row', async (context) => {
    const { paths, command } = homeDeclaring(context, true);
    const rows = (JSON.parse(await detected(paths, true)) as { managed: Array<Record<string, unknown>> }).managed;
    expect(rows.filter((row) => row['shape'] === 'managed' && row['id'] === DECLARED_ID)).toEqual([{ shape: 'managed', id: DECLARED_ID, provider: DECLARED_ID, binary: command }]);
  });

  it('prints the declared server in the text listing', async (context) => {
    const { paths, command } = homeDeclaring(context, true);
    expect(await detected(paths, false)).toContain(`found the managed server ${DECLARED_ID} at ${command}`);
  });

  it('lists no managed row when the declared command does not exist', async (context) => {
    const { paths } = homeDeclaring(context, false);
    const rows = (JSON.parse(await detected(paths, true)) as { managed: Array<Record<string, unknown>> }).managed;
    expect(rows.filter((row) => row['shape'] === 'managed' && row['id'] === DECLARED_ID)).toEqual([]);
  });
});
