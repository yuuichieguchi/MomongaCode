import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createTempDir } from '@momonga/testkit';
import type { ChildLaunch } from '../src/ports.ts';
import { directoryEntriesOn } from '../src/file-listing.ts';
import { nodeChildPorts } from '../src/node-ports.ts';
import { workTreeObserverOn } from '../src/work-tree-observer.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SYSTEM_GIT = '/usr/bin/git';

type Launched = { argv: readonly string[]; scratch: readonly string[] };

const recordingLaunch = (): { launch: ChildLaunch; launched: Launched[] } => {
  const launched: Launched[] = [];
  return {
    launched,
    launch: {
      protection: { kind: 'home-denied', home: '/never/the/home', denied: ['/never/the/home/run'] },
      commandOf: (argv, scratch) => {
        launched.push({ argv, scratch });
        const [file, ...args] = argv;
        return { file: file!, args };
      },
    },
  };
};

let root = '';

const repository = (): string => {
  root = createTempDir();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync(SYSTEM_GIT, ['init', '-q'], { cwd: project, env });
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  return project;
};

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('every process a tool starts outside the command sandbox goes through the launch that carries the protection of the home', () => {
  it('the work-tree observer starts each git through the launch, with only its store allowed back', async () => {
    const project = repository();
    const storeRoot = path.join(root, 'state', 'observer');
    const { launch, launched } = recordingLaunch();
    const observer = workTreeObserverOn({ child: nodeChildPorts(), files: nodeFileSystem, searchPath: '/usr/bin:/bin', processId: process.pid, launch }, { storeRoot, cwd: project, trusted: true });

    const mark = await observer.mark(new AbortController().signal);

    expect(mark).toBeDefined();
    expect(launched.length).toBeGreaterThan(0);
    expect(launched.every((entry) => entry.argv[0] === 'git' && entry.scratch.length === 1 && entry.scratch[0]!.startsWith(storeRoot))).toBe(true);
  });

  it('the file listing starts git through the launch, with nothing allowed back', async () => {
    const project = repository();
    const { launch, launched } = recordingLaunch();

    const entries = await directoryEntriesOn({ child: nodeChildPorts(), files: nodeFileSystem, launch }, { root: project, env: { PATH: '/usr/bin:/bin' }, trusted: true, signal: new AbortController().signal });

    expect(entries).toContain('a.txt');
    expect(launched).toHaveLength(1);
    expect(launched[0]!.scratch).toEqual([]);
  });
});
