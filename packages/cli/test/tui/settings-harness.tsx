import fs from 'node:fs';
import path from 'node:path';
import { momongaLayout, sha256Hex, systemTiming } from '@momonga/foundation';
import { App } from '../../src/tui/app.tsx';
import type { AppProps } from '../../src/tui/app.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackend, FakeBackendOptions } from '../fake-backend.ts';
import { freshHome } from '../fresh-home.ts';
import { KEYS, renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

export type Place = { home: string; project: string; userFile: string; projectFile: string };

export const freshPlace = (): Place => {
  const root = freshHome();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { home, project, userFile: momongaLayout(home, process.platform, {}).settingsFile, projectFile: path.join(project, '.momonga', 'settings.json') };
};

export const localFileOf = (place: Place): string => path.join(momongaLayout(place.home, process.platform, {}).projects, sha256Hex(fs.realpathSync(place.project)), 'settings.local.json');

export const unwrapped = (frame: string): string => frame.replace(/[│\s]+/g, ' ');

const packed = (text: string): string => text.replace(/[│\s]+/g, '');

export const outputHolds = ({ app }: Started, text: string): Promise<string> => untilOutput(app, (output) => packed(output).includes(packed(text)));

export const writeSettings = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
};

export const stored = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

export type Started = { app: Instance; backend: FakeBackend; place: Place };

export const startAt = async (place: Place, options: FakeBackendOptions = {}, tuiSettings?: TuiSettingsPort, { size = { columns: 140, rows: 120 }, ...extra }: Partial<Pick<AppProps, 'externalEditor'>> & { size?: { columns: number; rows: number } } = {}): Promise<Started> => {
  const backend = fakeBackend({ settingsPlace: { home: place.home, projectDir: place.project }, ...options });
  const terminal = fakeScreenTerminal(size);
  const app = renderObservable(<App backend={backend} terminal={terminal} initialMode={undefined} now={Date.now} timers={systemTiming} {...(tuiSettings === undefined ? {} : { tuiSettings })} {...extra} onExit={() => undefined} />);
  await untilFrame(app, 'mode: manual');
  return { app, backend, place };
};

export const command = async ({ app }: Started, line: string, shown: string): Promise<string> => {
  app.stdin.write(line);
  await untilFrame(app, `> ${line}`);
  app.stdin.write(KEYS.enter);
  return untilFrame(app, shown);
};

export const press = async ({ app }: Started, keys: string, shown: string | RegExp | ((frame: string) => boolean)): Promise<string> => {
  app.stdin.write(keys);
  return untilFrame(app, typeof shown === 'string' ? (frame) => frame.includes(shown) || unwrapped(frame).includes(shown) : shown);
};

export const typeInto = async (started: Started, text: string, shown: string | ((frame: string) => boolean)): Promise<string> => {
  await press(started, text, text);
  return press(started, KEYS.enter, shown);
};
