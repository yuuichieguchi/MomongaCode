import { describe, expect, it } from 'vitest';
import { modelNamingOf } from '@momonga/config';

const at = (baseUrl: string, more: Record<string, unknown> = {}): string => modelNamingOf({ adapter: 'chat-completions', baseUrl, ...more });

describe('a model is named by its server when its connection is on the person own machine or network', () => {
  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:11434'],
    ['IPv4 loopback written short', 'http://127.1:8080'],
    ['localhost', 'http://localhost:1234/v1'],
    ['10/8', 'http://10.1.2.3:8000/v1'],
    ['172.16/12', 'http://172.31.0.9:8000/v1'],
    ['192.168/16', 'http://192.168.1.20:11434'],
    ['link-local', 'http://169.254.10.10:8000'],
    ['CGNAT 100.64/10', 'http://100.100.1.1:8000'],
    ['IPv6 loopback', 'http://[::1]:8000'],
    ['IPv6 unique local', 'http://[fd12:3456::1]:8000'],
    ['IPv6 link-local', 'http://[fe80::1]:8000'],
    ['a .local name', 'http://gpu-box.local:8000/v1'],
    ['an unqualified host name', 'http://gpu-box:8000/v1'],
    ['a local server reached with a key', 'https://192.168.1.5:8443/v1'],
  ])('%s', (_case, baseUrl) => {
    expect(at(baseUrl, { apiKeyEnv: 'KEY' })).toBe('server');
    expect(at(baseUrl)).toBe('server');
  });

  it('a Unix socket and a managed server are servers', () => {
    expect(modelNamingOf({ adapter: 'chat-completions', socketPath: '/tmp/s.sock' })).toBe('server');
    expect(modelNamingOf({ adapter: 'managed', server: 'fm' })).toBe('server');
  });

  it.each([
    ['a public host', 'https://api.openai.com/v1'],
    ['a public host without a key', 'https://example.com/v1'],
    ['172.32 is outside 172.16/12', 'http://172.32.0.1:8000'],
    ['100.128 is outside 100.64/10', 'http://100.128.0.1:8000'],
    ['a public IPv6 address', 'http://[2001:db8::1]:8000'],
  ])('%s is an account', (_case, baseUrl) => {
    expect(at(baseUrl)).toBe('account');
  });

  it('a plan connection is an account, and a connection with no address is an account', () => {
    expect(modelNamingOf({ adapter: 'open-responses', plan: { profile: 'chatgpt' } })).toBe('account');
    expect(modelNamingOf({ adapter: 'open-responses', baseUrl: 'http://127.0.0.1:9', plan: { profile: 'chatgpt' } })).toBe('account');
    expect(modelNamingOf({ adapter: 'anthropic', apiKeyEnv: 'KEY' })).toBe('account');
  });
});
