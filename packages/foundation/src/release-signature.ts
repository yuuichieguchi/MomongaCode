import type { CommandRunner } from './platform/command-runner.ts';

export const RELEASE_SIGNATURE_NAMESPACE = 'momonga-release';
export const RELEASE_CHECKSUMS_ASSET = 'SHA256SUMS';
export const RELEASE_SIGNATURE_ASSET = 'SHA256SUMS.sig';
export const RELEASE_SIGNATURE_TOOL = 'ssh-keygen';
export const RELEASE_PUBLIC_KEY_PATTERN =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?$/;

export type PlacedFile = { readonly path: string; remove(): Promise<void> };

export type PlaceFile = (content: string) => Promise<PlacedFile>;

export type ReleaseSignatureVerdict = { kind: 'valid' } | { kind: 'invalid'; detail: string };

export type VerifyReleaseSignatureInput = {
  run: CommandRunner;
  env: Readonly<Record<string, string>>;
  place: PlaceFile;
  publicKey: string;
  checksums: string;
  signature: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export const verifyReleaseSignature = async (input: VerifyReleaseSignatureInput): Promise<ReleaseSignatureVerdict> => {
  const signers = await input.place(`${RELEASE_SIGNATURE_NAMESPACE} ${input.publicKey}\n`);
  try {
    const signature = await input.place(input.signature);
    try {
      const result = await input.run(
        RELEASE_SIGNATURE_TOOL,
        ['-Y', 'verify', '-f', signers.path, '-I', RELEASE_SIGNATURE_NAMESPACE, '-n', RELEASE_SIGNATURE_NAMESPACE, '-s', signature.path],
        {
          env: input.env,
          input: input.checksums,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      if (result.exitCode === 0) return { kind: 'valid' };
      return { kind: 'invalid', detail: `${result.stderr}${result.stdout}`.trim() };
    } finally {
      await signature.remove();
    }
  } finally {
    await signers.remove();
  }
};
