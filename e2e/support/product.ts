import fs from 'node:fs';
import path from 'node:path';
import type { FakeChatCompletionsServer, FakeRoute, FakeScriptedReply, RecordedRequest } from '@momonga/testkit';
import { createE2eHome } from './home.ts';
import type { E2eHome } from './home.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, withUpstreamEntry, writeSettingsFile } from './stack.ts';
import { E2E_IMAGE_TOKENS } from './upstream.ts';

export type ProductOptions = {
  script?: FakeScriptedReply[];
  routes?: FakeRoute[];
  settings?: Readonly<Record<string, unknown>>;
  imageInput?: boolean;
  contextWindow?: number;
};

export type Product = { home: E2eHome; fake: FakeChatCompletionsServer };

export const WINDOW_WITH_ROOM_FOR_ALL_TOOLS_AND_AN_IMAGE = 32768;

const withCapabilities = (settings: Record<string, unknown>, capabilities: Record<string, unknown>): Record<string, unknown> =>
  withUpstreamEntry(settings, (entry) => ({ ...entry, capabilities: { ...entry.capabilities, ...capabilities } }));

export const prepareProduct = async (options: ProductOptions = {}): Promise<Product> => {
  const home = await createE2eHome();
  const fake = await startUpstream(home, {
    home,
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.routes === undefined ? {} : { routes: options.routes }),
    upstreamImageInput: options.imageInput === true,
  });
  const base = baseSettings(home, sandboxChoiceOf({ home }).kind);
  const capabilities = {
    ...(options.imageInput === true ? { imageInput: true, imageTokens: E2E_IMAGE_TOKENS } : {}),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  };
  writeSettingsFile(home, { ...withCapabilities(base, capabilities), ...options.settings });
  return { home, fake };
};

export const writeUserSkill = (home: E2eHome, name: string, description: string): string => {
  const directory = path.join(home.paths.skills, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nFollow the ${name} procedure.\n`);
  return directory;
};

export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('momonga e2e image payload')]);

export const writePng = (directory: string, name: string): string => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, PNG_BYTES);
  return file;
};

export const requestText = (request: RecordedRequest | undefined): string => {
  if (request === undefined) throw new Error('the upstream did not receive the request');
  return JSON.stringify(request.body);
};
