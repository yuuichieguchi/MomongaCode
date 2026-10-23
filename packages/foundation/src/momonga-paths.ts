import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSocketPathLength } from './socket-path.ts';

export interface MomongaPaths {
  root: string;
  settingsFile: string;
  run: string;
  sockets: { gateway: string; runtime: string; fm: string; supervisor: string };
  locks: { gateway: string; runtime: string };
  markers: { root: string; tools: string; mcp: string; fm: string };
  state: string;
  databases: { runtime: string; gateway: string };
  traces: { dir: string; gateway: string; runtime: string };
  gatewayKey: string;
  probe: string;
  logs: string;
  projects: string;
  skills: string;
  cacheBase: string;
  tmp: { root: string; spawn: string; sessions: string };
}

const cacheBaseOf = (home: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string => {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'momonga');
  const xdg = env['XDG_CACHE_HOME'];
  return path.join(xdg === undefined || !path.isAbsolute(xdg) ? path.join(home, '.cache') : xdg, 'momonga');
};

export const momongaLayout = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MomongaPaths => {
  const root = path.join(home, '.momonga');
  const run = path.join(root, 'run');
  const state = path.join(root, 'state');
  const markers = path.join(run, 'markers');
  const traces = path.join(state, 'traces');
  const cacheBase = cacheBaseOf(home, platform, env);
  const tmp = path.join(cacheBase, 'tmp');
  return {
    root,
    settingsFile: path.join(root, 'settings.json'),
    run,
    sockets: {
      gateway: path.join(run, 'gateway.sock'),
      runtime: path.join(run, 'runtime.sock'),
      fm: path.join(run, 'fm.sock'),
      supervisor: path.join(run, 'supervisor.sock'),
    },
    locks: { gateway: path.join(run, 'gateway.lock'), runtime: path.join(run, 'runtime.lock') },
    markers: {
      root: markers,
      tools: path.join(markers, 'tools'),
      mcp: path.join(markers, 'mcp'),
      fm: path.join(markers, 'fm'),
    },
    state,
    databases: { runtime: path.join(state, 'runtime.db'), gateway: path.join(state, 'gateway.db') },
    traces: { dir: traces, gateway: path.join(traces, 'gateway.db'), runtime: path.join(traces, 'runtime.db') },
    gatewayKey: path.join(state, 'gateway.key'),
    probe: path.join(state, 'probe'),
    logs: path.join(root, 'logs'),
    projects: path.join(root, 'projects'),
    skills: path.join(root, 'skills'),
    cacheBase,
    tmp: { root: tmp, spawn: path.join(tmp, 'spawn'), sessions: path.join(tmp, 'sessions') },
  };
};

export const momongaPaths = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MomongaPaths => {
  const paths = momongaLayout(home, platform, env);
  for (const socket of Object.values(paths.sockets)) assertSocketPathLength(socket);
  return paths;
};

export const ensureMomongaDirs = async (paths: MomongaPaths): Promise<void> => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('process.getuid is required to verify directory ownership');
  const ensureDirectory = async (directory: string): Promise<void> => {
    let stat = await lstatIfPresent(directory);
    if (stat === undefined) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = await fs.lstat(directory);
    }
    if (stat.isSymbolicLink()) throw new Error(`${directory} is a symlink; refusing to use it`);
    if (!stat.isDirectory()) throw new Error(`${directory} exists and is not a directory`);
    if (stat.uid !== uid) {
      throw new Error(`${directory} is owned by uid ${stat.uid}, but the current user is uid ${uid}; the directory must be owned by the current user`);
    }
    if ((stat.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
  };
  await fs.mkdir(path.dirname(paths.root), { recursive: true });
  for (const directory of [
    paths.root,
    paths.run,
    paths.markers.root,
    paths.markers.tools,
    paths.markers.mcp,
    paths.markers.fm,
    paths.state,
    paths.traces.dir,
    paths.probe,
    paths.logs,
    paths.projects,
    paths.skills,
  ]) {
    await ensureDirectory(directory);
  }
  await fs.mkdir(path.dirname(paths.cacheBase), { recursive: true });
  for (const directory of [paths.cacheBase, paths.tmp.root, paths.tmp.spawn, paths.tmp.sessions]) {
    await ensureDirectory(directory);
  }
};

const lstatIfPresent = async (target: string): Promise<fsSync.Stats | undefined> => {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
