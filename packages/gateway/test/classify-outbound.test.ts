import { describe, expect, it } from 'vitest';
import { OutboundConnectionError } from '@momonga/foundation';
import type { OutboundFailure } from '@momonga/foundation';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';

const classify = createUpstreamClassifier('chat-completions');
const PROXY = 'http://proxy.corp:3128';

const cases: ReadonlyArray<{ failure: OutboundFailure; retryable: boolean; code: string }> = [
  { failure: { kind: 'proxy-unreachable', proxy: PROXY, source: 'HTTPS_PROXY', code: 'ECONNREFUSED' }, retryable: true, code: 'provider_unavailable' },
  { failure: { kind: 'proxy-refused', proxy: PROXY, source: 'HTTPS_PROXY', status: 502 }, retryable: true, code: 'provider_unavailable' },
  { failure: { kind: 'proxy-refused', proxy: PROXY, source: 'HTTPS_PROXY', status: 403 }, retryable: false, code: 'proxy_refused' },
  { failure: { kind: 'proxy-auth', proxy: PROXY, source: 'network.httpsProxy' }, retryable: false, code: 'proxy_authentication_required' },
  { failure: { kind: 'proxy-tls', proxy: 'https://proxy.corp:443', source: 'HTTPS_PROXY', code: 'SELF_SIGNED_CERT_IN_CHAIN', caSources: ['bundled', 'system'] }, retryable: false, code: 'proxy_tls_failed' },
  { failure: { kind: 'proxy-unsupported', source: 'ALL_PROXY', text: 'ALL_PROXY socks5://proxy.corp:1080: only http and https proxies are supported' }, retryable: false, code: 'proxy_unsupported' },
  { failure: { kind: 'origin-certificate', host: 'model.example.test', code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', caSources: ['bundled', 'system'] }, retryable: false, code: 'certificate_untrusted' },
  { failure: { kind: 'ca-file', file: '/etc/corp/ca.pem', source: 'SSL_CERT_FILE', reason: 'the file could not be read (ENOENT)' }, retryable: false, code: 'ca_file_unreadable' },
];

describe('createUpstreamClassifier: outbound connection failures', () => {
  it.for(cases)('classifies $failure.kind as retryable $retryable with code $code and keeps the hop text', ({ failure, retryable, code }) => {
    const error = new OutboundConnectionError(failure);

    const classified = classify(error);

    expect(classified.retryable).toBe(retryable);
    expect(classified.error.code).toBe(code);
    expect(classified.error.message).toContain(error.message);
  });

  it('finds the outbound failure under the TypeError that fetch wraps it in', () => {
    const inner = new OutboundConnectionError({ kind: 'proxy-auth', proxy: PROXY, source: 'HTTPS_PROXY' });

    const classified = classify(new TypeError('fetch failed', { cause: inner }));

    expect(classified.error.code).toBe('proxy_authentication_required');
  });

  it('names the proxy and its source in an unreachable proxy failure, keeping the upstream label', () => {
    const classified = classify(new OutboundConnectionError({ kind: 'proxy-unreachable', proxy: PROXY, source: 'HTTPS_PROXY', code: 'UND_ERR_HEADERS_TIMEOUT' }));

    expect(classified.error.message).toContain('the chat-completions upstream is unreachable');
    expect(classified.error.message).toContain(PROXY);
    expect(classified.error.message).toContain('HTTPS_PROXY');
  });

  it('keeps the direct-route text unchanged for an unlabelled connection failure', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });

    expect(classify(refused).error.message).toBe('the chat-completions upstream is unreachable');
  });
});
