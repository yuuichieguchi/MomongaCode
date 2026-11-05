import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, createManagedFmTarget } from '@momonga/gateway';
import type { FmServe } from '@momonga/gateway';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, makeDir, registerCleanup } from './gateway-helpers.ts';
import { collect, ofType, readFileTool, startFake, userText } from './cc-support.ts';

const servingFake = (socketPath: string): FmServe => ({
  restarts: 0,
  start: async () => ({ kind: 'unix', socketPath }),
  ensureRunning: async () => ({ kind: 'unix', socketPath }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
});

describe('an fm target with no probe record', () => {
  it('answers a tool request with a function call', async () => {
    const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
    const managed = await createManagedFmTarget({
      fmServe: servingFake(fake.socketPath),
      binary: '/usr/bin/fm',
      exec: async () => ({ exitCode: 0, stdout: '20\n', stderr: '' }),
      probeRecordDir: path.join(makeDir(), 'probe'),
      recordKey: { target: 'fm', binarySha256: 'ab'.repeat(32), osBuild: '25A100' },
      toolCallingSetting: 'auto',
    });
    const adapter = createChatCompletionsAdapter({ ...managed, clock: createFakeClock(START_MS) });
    registerCleanup(() => adapter.close());

    const { events, error } = await collect(adapter, { model: 'system', input: [userText('Please call read_file on README.md')], tools: [readFileTool] });

    expect(error).toBeUndefined();
    const items = ofType(events, 'response.output_item.done').map((event) => [event.item.type, event.item.name]);
    expect(items).toContainEqual(['function_call', 'read_file']);
  });
});
