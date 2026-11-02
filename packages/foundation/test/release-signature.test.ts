import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_SIGNATURE_KNOWN_ANSWER, nodeCommandRunner, verifyReleaseSignature } from '@momonga/foundation';
import type { CommandRunner, PlaceFile } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';

const USAGE = 'unknown option -- Y\nusage: ssh-keygen [-q] [-a rounds] [-b bits]';

const place: PlaceFile = async (content) => ({ path: `/placed/${content.length}`, remove: async () => undefined });

const toolWithoutSignatureVerification = (): { run: CommandRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const run = (async (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    return { exitCode: 1, stdout: '', stderr: USAGE };
  }) as unknown as CommandRunner;
  return { run, calls };
};

const rejecting = (knownAnswerExitCode: number): CommandRunner =>
  (async (_file: string, _args: readonly string[], options: { input?: string }) => ({
    exitCode: options.input === RELEASE_SIGNATURE_KNOWN_ANSWER.content ? knownAnswerExitCode : 255,
    stdout: '',
    stderr: 'Could not verify signature.',
  })) as unknown as CommandRunner;

describe('the embedded known answer', () => {
  it('is accepted by the real ssh-keygen', async (context) => {
    const directory = withTempDir(context);
    const placeOnDisk: PlaceFile = async (content) => {
      const file = path.join(directory, `placed-${fs.readdirSync(directory).length}`);
      fs.writeFileSync(file, content, { mode: 0o600 });
      return { path: file, remove: async () => fs.rmSync(file) };
    };
    const known = RELEASE_SIGNATURE_KNOWN_ANSWER;

    const verdict = await verifyReleaseSignature({ run: nodeCommandRunner, env: { PATH: process.env['PATH'] ?? '' }, place: placeOnDisk, publicKey: known.publicKey, checksums: known.content, signature: known.signature });

    expect(verdict).toEqual({ kind: 'valid' });
  });
});

describe('verifyReleaseSignature on exit status 255', () => {
  it('reports a rejected signature when the tool still verifies the known answer', async () => {
    const verdict = await verifyReleaseSignature({ run: rejecting(0), env: {}, place, publicKey: 'ssh-ed25519 AAAA', checksums: 'x', signature: 'y' });

    expect(verdict).toEqual({ kind: 'invalid', detail: 'Could not verify signature.' });
  });

  it('reports the tool as unusable when it cannot verify the known answer either', async () => {
    const verdict = await verifyReleaseSignature({ run: rejecting(255), env: {}, place, publicKey: 'ssh-ed25519 AAAA', checksums: 'x', signature: 'y' });

    expect(verdict).toEqual({ kind: 'tool_unusable', detail: 'Could not verify signature.' });
  });

  it('does not run the known answer for a signature that verifies', async () => {
    const inputs: Array<string | undefined> = [];
    const run = (async (_file: string, _args: readonly string[], options: { input?: string }) => {
      inputs.push(options.input);
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as unknown as CommandRunner;

    await verifyReleaseSignature({ run, env: {}, place, publicKey: 'ssh-ed25519 AAAA', checksums: 'x', signature: 'y' });

    expect(inputs).toEqual(['x']);
  });
});

describe('verifyReleaseSignature with a tool that cannot verify signatures', () => {
  it('reports the tool as unusable, not the signature as invalid', async () => {
    const { run } = toolWithoutSignatureVerification();

    const verdict = await verifyReleaseSignature({ run, env: {}, place, publicKey: 'ssh-ed25519 AAAA', checksums: 'x', signature: 'y' });

    expect(verdict).toEqual({ kind: 'tool_unusable', detail: USAGE });
  });
});
