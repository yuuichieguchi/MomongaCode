import type { CommandRunner } from './platform/command-runner.ts';
import { SIGNATURE_REJECTED_EXIT_CODE } from './process-contract.ts';

export const RELEASE_SIGNATURE_NAMESPACE = 'momonga-release';
export const RELEASE_CHECKSUMS_ASSET = 'SHA256SUMS';
export const RELEASE_SIGNATURE_ASSET = 'SHA256SUMS.sig';
export const RELEASE_SIGNATURE_TOOL = 'ssh-keygen';
export const RELEASE_PUBLIC_KEY_PATTERN =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?$/;

export type PlacedFile = { readonly path: string; remove(): Promise<void> };

export type PlaceFile = (content: string) => Promise<PlacedFile>;

export type ReleaseSignatureVerdict = { kind: 'valid' } | { kind: 'invalid'; detail: string } | { kind: 'tool_unusable'; detail: string };

export type VerifyReleaseSignatureInput = {
  run: CommandRunner;
  env: Readonly<Record<string, string>>;
  place: PlaceFile;
  publicKey: string;
  checksums: string;
  signature: string;
  signal?: AbortSignal;
};

export const RELEASE_SIGNATURE_KNOWN_ANSWER = {
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFwe8TGwVyt4tOBlS8ZQ4u0RZPmNbMoDh39vu78BBdz/',
  content: 'momonga-known-answer\n',
  signature: [
    '-----BEGIN SSH SIGNATURE-----',
    'U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgXB7xMbBXK3i04GVLxlDi7RFk+Y',
    '1sygOHf2+7vwEF3P8AAAAPbW9tb25nYS1yZWxlYXNlAAAAAAAAAAZzaGE1MTIAAABTAAAA',
    'C3NzaC1lZDI1NTE5AAAAQCeeh0B8rYw6InWFDGdscolZEvxOMcA70RC5KdVBVIQwO13qy9',
    'QwXGKVndeMYhS5P1o3zbFtOwrgq7hpDJelowo=',
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n'),
} as const;

type VerificationOutcome = { exitCode: number; detail: string };

const runVerification = async (
  input: VerifyReleaseSignatureInput,
  publicKey: string,
  checksums: string,
  signatureText: string,
): Promise<VerificationOutcome> => {
  const signers = await input.place(`${RELEASE_SIGNATURE_NAMESPACE} ${publicKey}\n`);
  try {
    const signature = await input.place(signatureText);
    try {
      const result = await input.run(
        RELEASE_SIGNATURE_TOOL,
        ['-Y', 'verify', '-f', signers.path, '-I', RELEASE_SIGNATURE_NAMESPACE, '-n', RELEASE_SIGNATURE_NAMESPACE, '-s', signature.path],
        {
          env: input.env,
          input: checksums,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      return { exitCode: result.exitCode, detail: `${result.stderr}${result.stdout}`.trim() };
    } finally {
      await signature.remove();
    }
  } finally {
    await signers.remove();
  }
};

export const verifyReleaseSignature = async (input: VerifyReleaseSignatureInput): Promise<ReleaseSignatureVerdict> => {
  const outcome = await runVerification(input, input.publicKey, input.checksums, input.signature);
  if (outcome.exitCode === 0) return { kind: 'valid' };
  if (outcome.exitCode !== SIGNATURE_REJECTED_EXIT_CODE) return { kind: 'tool_unusable', detail: outcome.detail };
  const known = RELEASE_SIGNATURE_KNOWN_ANSWER;
  const control = await runVerification(input, known.publicKey, known.content, known.signature);
  if (control.exitCode !== 0) return { kind: 'tool_unusable', detail: outcome.detail };
  return { kind: 'invalid', detail: outcome.detail };
};
