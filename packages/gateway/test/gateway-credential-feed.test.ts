import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import path from 'node:path';
import { makeDir, startGateway } from './gateway-helpers.ts';

describe('credential feed', () => {
  it('is subscribed before the gateway listens and redacts what it later adds', async () => {
    const adapter = createScriptedAdapter({ calls: [] });
    const dir = makeDir();
    const socketPath = path.join(dir, 'gw.sock');
    let listeningWhenSubscribed: boolean | undefined;
    let add: ((credential: string) => void) | undefined;
    await startGateway({
      dir,
      adapters: { 'scripted/scripted-primary': adapter },
      credentialFeed: (feed) => {
        listeningWhenSubscribed = fs.existsSync(socketPath);
        add = feed;
      },
    });
    expect(listeningWhenSubscribed).toBe(false);
    expect(add).toBeTypeOf('function');
  });
});
