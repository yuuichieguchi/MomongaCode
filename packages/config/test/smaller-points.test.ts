import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { telemetryWithReferences } from '@momonga/config';
import { assertSettings } from '../src/settings.ts';

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('no error was thrown');
};

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

const connectionWith = (adapter: string, keys: Record<string, string>): unknown => ({
  models: { connections: [{ adapter, baseUrl: 'https://api.example.com/v1', ...keys, models: [{ id: 'm', capabilities: CAPABILITIES }] }] },
});

describe('a connection with both or neither credential key names the other key (config-C24 R6)', () => {
  it.each(['chat-completions', 'anthropic'])('both keys on %s: set one of apiKeyEnv or apiKeySecret, not both', (adapter) => {
    expect(messageOf(() => assertSettings(connectionWith(adapter, { apiKeyEnv: 'API_KEY', apiKeySecret: 'key' }), 'settings.json'))).toBe(
      'settings.json: invalid settings at /models/connections/0: set one of apiKeyEnv or apiKeySecret, not both',
    );
  });

  it('neither key where one is needed: needs apiKeyEnv or apiKeySecret', () => {
    expect(messageOf(() => assertSettings(connectionWith('anthropic', {}), 'settings.json'))).toBe('settings.json: invalid settings at /models/connections/0: needs apiKeyEnv or apiKeySecret');
  });
});

describe('telemetry.otlp.headers take their values through the one expansion (config-C24 R2)', () => {
  const telemetry = { otlp: { endpoint: 'https://collector.example', headers: { authorization: 'Bearer ${OTLP_TOKEN}', team: '${TEAM:-core}', literal: '$${OTLP_TOKEN}' } } };

  it('expands ${NAME}, ${NAME:-default} and keeps $${NAME} literal', () => {
    expect(telemetryWithReferences(telemetry, { OTLP_TOKEN: 't0k' })).toEqual({
      otlp: { endpoint: 'https://collector.example', headers: { authorization: 'Bearer t0k', team: 'core', literal: '${OTLP_TOKEN}' } },
    });
  });

  it('refuses an unset variable naming the header and the variable', () => {
    expect(messageOf(() => telemetryWithReferences(telemetry, {}))).toBe('telemetry.otlp.headers.authorization needs environment variable OTLP_TOKEN, which is not set');
  });

  it('leaves settings without headers as they are', () => {
    expect(telemetryWithReferences(undefined, {})).toBeUndefined();
    expect(telemetryWithReferences({ captureMessageContent: true }, {})).toEqual({ captureMessageContent: true });
  });
});

describe('exports no product file reads are gone (config-C24 R4)', () => {
  it.each(['secretNames', 'planAccountNames', 'NON_CORE_SETTING_KEYS', 'MODELS_SETTING_WRITERS', 'autoFitViewOf', 'readAutoFitRecord'])('%s', (name) => {
    expect(Object.hasOwn(config, name)).toBe(false);
  });
});

describe('the admission wait default is one named value (config-C24 R3)', () => {
  it('models.ts writes 30 000 once', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'models.ts'), 'utf8');
    expect(source.match(/\b30_?000\b/gu)).toHaveLength(1);
    expect(fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'adapters.ts'), 'utf8')).not.toMatch(/maxBreakpoints: \d/u);
  });
});
