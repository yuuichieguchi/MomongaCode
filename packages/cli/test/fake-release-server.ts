import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UpdateEndpoints } from '../src/update/source.ts';

export type FakeFile = { body: Buffer; interruptAfterBytes?: number };

export type FakeReleaseServer = {
  readonly endpoints: UpdateEndpoints;
  readonly requests: string[];
  latestTag: string | undefined;
  latestStatus: number;
  latestBody: string | undefined;
  readonly files: Map<string, FakeFile>;
  publish(tag: string, assets: Readonly<Record<string, Buffer>>, options?: { checksums?: string | undefined; signature?: string | undefined }): void;
  stop(): Promise<void>;
};

export const DEFAULT_SIGNATURE = '-----BEGIN SSH SIGNATURE-----\nscripted\n-----END SSH SIGNATURE-----\n';

export const sha256Of = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

export const checksumListing = (assets: Readonly<Record<string, Buffer>>): string =>
  Object.entries(assets)
    .map(([name, body]) => `${sha256Of(body)}  ${name}\n`)
    .join('');

const DOWNLOAD_PATH = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
const CDN_PATH = /^\/cdn\/([^/]+)\/([^/]+)$/;

export const startFakeReleaseServer = async (repo: string): Promise<FakeReleaseServer> => {
  const files = new Map<string, FakeFile>();
  const requests: string[] = [];
  const state = { latestTag: undefined as string | undefined, latestStatus: 200, latestBody: undefined as string | undefined };
  const server = http.createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(`${request.method} ${url}`);
    if (url === `/repos/${repo}/releases/latest`) {
      response.writeHead(state.latestStatus, { 'content-type': 'application/json' });
      response.end(state.latestBody ?? JSON.stringify({ tag_name: state.latestTag }));
      return;
    }
    const download = DOWNLOAD_PATH.exec(url);
    if (download !== null && download[1] === repo) {
      response.writeHead(302, { location: `/cdn/${download[2]}/${download[3]}` });
      response.end();
      return;
    }
    const cdn = CDN_PATH.exec(url);
    const file = cdn === null ? undefined : files.get(`${cdn[1]}/${cdn[2]}`);
    if (file === undefined) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-length': file.body.length });
    if (file.interruptAfterBytes === undefined) {
      response.end(file.body);
      return;
    }
    response.write(file.body.subarray(0, file.interruptAfterBytes), () => {
      response.socket?.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: { apiBaseUrl: origin, downloadBaseUrl: origin },
    requests,
    files,
    get latestTag() {
      return state.latestTag;
    },
    set latestTag(value) {
      state.latestTag = value;
    },
    get latestStatus() {
      return state.latestStatus;
    },
    set latestStatus(value) {
      state.latestStatus = value;
    },
    get latestBody() {
      return state.latestBody;
    },
    set latestBody(value) {
      state.latestBody = value;
    },
    publish: (tag, assets, options = {}) => {
      state.latestTag = tag;
      for (const [name, body] of Object.entries(assets)) files.set(`${tag}/${name}`, { body });
      const checksums = 'checksums' in options ? options.checksums : checksumListing(assets);
      if (checksums !== undefined) files.set(`${tag}/SHA256SUMS`, { body: Buffer.from(checksums) });
      const signature = 'signature' in options ? options.signature : DEFAULT_SIGNATURE;
      if (signature !== undefined) files.set(`${tag}/SHA256SUMS.sig`, { body: Buffer.from(signature) });
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
