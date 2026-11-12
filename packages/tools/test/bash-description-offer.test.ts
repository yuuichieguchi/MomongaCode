import { describe, expect, it } from 'vitest';
import type { SandboxNetworkSetting } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import { createBuiltinTools } from '../src/builtins/index.ts';

const SHELL = '/opt/offered/bash-5';

type Texts = { description: string; concise: string; parameter: string };

const textsOf = (sandbox: Sandbox['kind'], sandboxNetwork: SandboxNetworkSetting): Texts => {
  const bash = createBuiltinTools({ sandbox, sandboxNetwork, bash: { kind: 'resolved', path: SHELL } }).find((tool) => tool.name === 'Bash');
  if (bash === undefined) throw new Error('no Bash tool');
  const network = (bash.inputSchema as { properties: { network: { description: string } } }).properties.network;
  return { description: bash.description, concise: bash.conciseDescription ?? '', parameter: network.description };
};

const all = (texts: Texts): string[] => [texts.description, texts.concise, texts.parameter];

describe('the Bash description states what the offered sandbox enforces', () => {
  for (const sandbox of ['seatbelt', 'bubblewrap'] as const) {
    it(`${sandbox} names the hosts form and the open form and keeps its sandbox claim`, () => {
      const texts = textsOf(sandbox, 'ask');
      for (const text of all(texts)) {
        expect(text).toContain('{"hosts"');
        expect(text).toContain('"open"');
      }
      expect(texts.description).toContain('inside a sandbox');
      expect(texts.description).toContain('The sandbox has no network');
    });
  }

  it('none names only the open form and makes no protection claim', () => {
    const texts = textsOf('none', 'ask');
    for (const text of all(texts)) {
      expect(text).not.toContain('{"hosts"');
      expect(text).toContain('"open"');
      expect(text).not.toContain('inside a sandbox');
      expect(text).not.toContain('The sandbox has no network');
      expect(text).not.toContain('through a proxy');
    }
    expect(texts.description).toContain('no sandbox');
  });

  it('says the person is asked only when the setting is ask', () => {
    for (const sandbox of ['seatbelt', 'bubblewrap', 'none'] as const) {
      for (const text of all(textsOf(sandbox, 'ask'))) expect(text).toContain('asks the person');
      for (const setting of ['allow', 'deny'] as const) {
        for (const text of all(textsOf(sandbox, setting))) {
          expect(text).not.toContain('asks the person');
          expect(text).not.toContain('asked');
        }
      }
    }
    expect(textsOf('seatbelt', 'deny').description).toContain('sandboxNetwork is deny');
    expect(textsOf('seatbelt', 'allow').description).toContain('sandboxNetwork is allow');
  });

  it('names the shell program that runs', () => {
    for (const sandbox of ['seatbelt', 'bubblewrap', 'none'] as const) {
      const texts = textsOf(sandbox, 'ask');
      expect(texts.description).toContain(SHELL);
      expect(texts.description).not.toContain('/bin/bash');
    }
  });
});
