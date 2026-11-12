import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, sha256Hex } from '@momonga/foundation';
import { harness, makeStoreDir } from '../../../store/test/helpers.ts';
import { runMemoryUpkeep } from '../../src/memory/upkeep.ts';
import { createRecordViews } from '../../src/memory/views.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

const SIGNAL = new AbortController().signal;

const setup = async () => {
  const { store, clock } = harness();
  const project = fs.realpathSync.native(makeStoreDir());
  await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
  const views = createRecordViews({ store, evidenceRun: () => async () => ({ exitCode: null }) });
  const bound = (name: string, content: string) => {
    fs.writeFileSync(path.join(project, name), content);
    return store.memories.addByCommand({ scope: 'project', project, text: `about ${name}`, evidence: [{ kind: 'file', project, path: name, sha256: sha256Hex(content) }] });
  };
  const upkeep = () => runMemoryUpkeep({ store, clock, fileSystem: nodeFileSystem, views, forgetAfterDays: async () => 90, batchSize: 100, signal: SIGNAL });
  return { store, clock, project, views, bound, upkeep };
};

describe('an upkeep page observes every active note', () => {
  it('a page observes every active note, not only idle ones', async () => {
    const { store, clock, project, bound, upkeep } = await setup();
    const fresh = bound('fresh.ts', 'first content');
    const unchanged = bound('same.ts', 'kept content');
    fs.writeFileSync(path.join(project, 'fresh.ts'), 'changed content');
    clock.advance(1000);
    await upkeep();
    expect(store.memories.observations(fresh.id).at(-1)).toEqual({ status: 'stale', observedAt: clock.now() });
    expect(store.memories.observations(unchanged.id).at(-1)?.status).toBe('verified');
    expect(store.memories.get(unchanged.id)?.observedStatus).toBe('verified');
    expect(store.memories.get(fresh.id)?.state).toBe('active');
  });

  it('observations do not move revision(), so a pass does not restart itself', async () => {
    const { store, clock, project, bound, upkeep } = await setup();
    const note = bound('fresh.ts', 'first content');
    fs.writeFileSync(path.join(project, 'fresh.ts'), 'changed content');
    clock.advance(1000);
    const before = store.memories.revision();
    await upkeep();
    expect(store.memories.get(note.id)?.observedStatus).toBe('stale');
    expect(store.memories.revision()).toBe(before);
  });
});

describe('an upkeep page asks the file-system port whether the folder of a note exists', () => {
  it('reads the folder through the port it is given, and skips a folder the port says is gone', async () => {
    const { store, clock, project, views, bound } = await setup();
    bound('kept.ts', 'content');
    const asked: string[] = [];
    const gone = Object.assign(new Error(`ENOENT: no such file or directory, stat '${project}'`), { code: 'ENOENT' });
    const fileSystem = {
      stat: async (file: string) => {
        asked.push(file);
        throw gone;
      },
    };
    const result = await runMemoryUpkeep({ store, clock, views, fileSystem, forgetAfterDays: async () => 90, batchSize: 100, signal: SIGNAL });
    expect(asked).toEqual([project]);
    expect(result.skipped).toEqual([project]);
  });
});
