import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { momongaLayout, sha256Hex } from '@momonga/foundation';

const realpath = promisify(fs.realpath.native);

export const localSettingsDirectory = async (home: string, projectDir: string): Promise<string> =>
  path.join(momongaLayout(home).projects, sha256Hex(await realpath(projectDir)));

export const localSettingsFile = async (home: string, projectDir: string): Promise<string> =>
  path.join(await localSettingsDirectory(home, projectDir), 'settings.local.json');
