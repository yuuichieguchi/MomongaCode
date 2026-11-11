import { describe, expect, it } from 'vitest';
import { commandSpecsFor, unaskedCommandsFor } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { answeredRun, chainBuilder, referenceHarness, referenceOf } from './support/reference.ts';

const PLATFORMS = ['linux', 'darwin'] as const;

const markerText = async (platform: NodeJS.Platform, from: PermissionMode, to: PermissionMode): Promise<string> => {
  const h = referenceHarness({ unaskedCommands: unaskedCommandsFor(platform) });
  const b = chainBuilder(h);
  await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true, mode: from });
  const child = await b.createRun('And again');
  expect(await b.inherit(b.claimNext(child.id), to)).toEqual({ kind: 'inherited' });
  const [marker] = referenceOf(h.store, child.id).synthesised;
  const content = marker?.item.type === 'message' ? marker.item.content : undefined;
  if (typeof content !== 'string') throw new Error('the reference holds no mode marker');
  return content;
};

const namesMarked = (platform: NodeJS.Platform, approval: 'read-only' | 'edit'): string[] =>
  commandSpecsFor(platform)
    .all.filter((spec) => spec.approval === approval)
    .flatMap((spec) => [...spec.names]);

const listedAfter = (text: string, lead: string): string[] => {
  const start = text.indexOf(lead);
  if (start < 0) throw new Error(`the marker holds no "${lead}": ${text}`);
  const rest = text.slice(start + lead.length);
  return rest.slice(0, rest.indexOf('.')).split(', ');
};

describe('the sentence about what runs without asking is built from the table the policy decides with', () => {
  it.each(PLATFORMS)('the policy lists every command its specs mark read-only or edit on %s', (platform) => {
    expect(unaskedCommandsFor(platform)).toEqual({ readOnly: namesMarked(platform, 'read-only'), edit: namesMarked(platform, 'edit') });
    expect(unaskedCommandsFor(platform).readOnly).toEqual(expect.arrayContaining(['grep', 'git', 'ls']));
    expect(unaskedCommandsFor(platform).edit).toEqual(expect.arrayContaining(['mkdir', 'rm']));
  });

  it.each(PLATFORMS.flatMap((platform) => (['manual', 'plan'] as const).map((mode) => [platform, mode] as const)))(
    'on %s the marker of a change to %s names every read-only command of the policy and no other',
    async (platform, mode) => {
      const text = await markerText(platform, 'acceptEdits', mode);
      expect(listedAfter(text, 'Read-only uses of these commands run without asking: ')).toEqual(namesMarked(platform, 'read-only'));
    },
  );

  it.each(PLATFORMS)('on %s the marker of a change to acceptEdits names every edit command and every read-only command of the policy', async (platform) => {
    const text = await markerText(platform, 'manual', 'acceptEdits');
    expect(listedAfter(text, 'these filesystem commands inside the workspace are accepted without asking: ')).toEqual(namesMarked(platform, 'edit'));
    expect(listedAfter(text, 'Read-only uses of these commands run without asking: ')).toEqual(namesMarked(platform, 'read-only'));
  });

  it('the lists differ by platform where the specs differ, with no platform named in the sentence', async () => {
    expect(unaskedCommandsFor('linux').readOnly).toContain('ps');
    expect(unaskedCommandsFor('darwin').readOnly).not.toContain('ps');
    expect(await markerText('linux', 'acceptEdits', 'manual')).not.toMatch(/Linux|macOS|Windows/);
  });
});
