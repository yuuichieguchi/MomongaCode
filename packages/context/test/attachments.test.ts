import { describe, expect, it } from 'vitest';
import {
  ATTACH_DIR_ENTRIES,
  ATTACH_MAX_FILES,
  admits,
  attachLimitsFor,
  attachMentions,
  directoryListing,
  mentionsOf,
  numberedContent,
} from '@momonga/context';
import type { AttachHost, AttachTarget } from '@momonga/context';

const encoder = new TextEncoder();

type FakeFile = { bytes: Uint8Array; size?: number; floor?: 'denied'; unreadable?: true } | { directory: readonly string[] } | { outside: true };

const fakeHost = (files: Readonly<Record<string, FakeFile | string>>, overrides: Partial<AttachHost> = {}): AttachHost & { reads: string[] } => {
  const reads: string[] = [];
  const entryOf = (path: string): FakeFile | undefined => {
    const found = files[path];
    return typeof found === 'string' ? { bytes: encoder.encode(found) } : found;
  };
  return {
    reads,
    ceiling: 1000,
    trusted: true,
    imageInput: false,
    tokens: (text) => text.length,
    resolve: async (path): Promise<AttachTarget | 'outside' | undefined> => {
      const entry = entryOf(path);
      if (entry === undefined) return undefined;
      if ('outside' in entry) return 'outside';
      if ('directory' in entry) return { absolute: `/root/${path}`, shown: path, kind: 'directory', size: 0 };
      return { absolute: `/root/${path}`, shown: path, kind: 'file', size: entry.size ?? entry.bytes.byteLength };
    },
    floor: async (absolute) => {
      const entry = entryOf(absolute.slice('/root/'.length));
      return entry !== undefined && 'floor' in entry ? 'denied' : 'allowed';
    },
    read: async (absolute, maxBytes) => {
      reads.push(absolute);
      const entry = entryOf(absolute.slice('/root/'.length));
      if (entry === undefined || !('bytes' in entry)) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      if (entry.unreadable === true) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return entry.bytes.subarray(0, maxBytes);
    },
    list: async (absolute) => {
      const entry = entryOf(absolute.slice('/root/'.length));
      if (entry === undefined || !('directory' in entry)) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return entry.directory;
    },
    ...overrides,
  };
};

describe('what counts as a mention', () => {
  it('takes a token at the start of the text and after whitespace', () => {
    expect(mentionsOf('@src/app.tsx fix this and\n@README.md too')).toEqual(['src/app.tsx', 'README.md']);
  });

  it('takes a quoted path with spaces', () => {
    expect(mentionsOf('look at @"my file.txt" please')).toEqual(['my file.txt']);
  });

  it('leaves an e-mail address, a code span and a code fence as plain text', () => {
    expect(mentionsOf('mail me@example.com or `@inline.ts` now')).toEqual([]);
    expect(mentionsOf('see\n```\n@fenced.ts\n```\nand @real.ts')).toEqual(['real.ts']);
  });

  it('names each path once, in the order written', () => {
    expect(mentionsOf('@b.ts @a.ts @b.ts')).toEqual(['b.ts', 'a.ts']);
  });
});

describe('the limits are shares of the context ceiling', () => {
  it('gives 10% per file, 25% per message and a read bound of four times the file share in bytes', () => {
    expect(attachLimitsFor(1000)).toEqual({ perFile: 100, total: 250, maxFiles: 16, readBytes: 1600 });
    expect(attachLimitsFor(1009)).toEqual({ perFile: 100, total: 252, maxFiles: 16, readBytes: 1600 });
  });
});

describe('the admission rule', () => {
  it('never admits more than a quarter of the ceiling, nor a file above a tenth, whatever the sizes are', () => {
    let state = 7;
    const next = (bound: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % bound;
    };
    for (let round = 0; round < 2000; round += 1) {
      const ceiling = 1 + next(300_000);
      const limits = attachLimitsFor(ceiling);
      let admitted = 0;
      for (let file = 0; file < limits.maxFiles; file += 1) {
        const estimate = next(Math.max(1, Math.floor(ceiling / 5)));
        if (!admits(limits, admitted, estimate)) continue;
        expect(estimate).toBeLessThanOrEqual(Math.floor(ceiling / 10));
        admitted += estimate;
      }
      expect(admitted).toBeLessThanOrEqual(Math.floor(ceiling / 4));
    }
  });

  it('refuses every larger file once it refuses one for its size', () => {
    const limits = attachLimitsFor(1000);
    expect(admits(limits, 0, 100)).toBe(true);
    expect(admits(limits, 0, 101)).toBe(false);
    expect(admits(limits, 0, 5000)).toBe(false);
    expect(admits(limits, 200, 50)).toBe(true);
    expect(admits(limits, 200, 51)).toBe(false);
  });
});

describe('the form of an attachment', () => {
  it('prefixes every line with its number', () => {
    expect(numberedContent('one\ntwo\n')).toBe('     1\tone\n     2\ttwo');
    expect(numberedContent('')).toBe('');
  });

  it('lists a directory with at most 200 entries and the count of the rest', () => {
    const names = Array.from({ length: ATTACH_DIR_ENTRIES + 3 }, (_unused, index) => `f${index}`);
    const listing = directoryListing(names).split('\n');
    expect(listing).toHaveLength(ATTACH_DIR_ENTRIES + 1);
    expect(listing.at(-1)).toBe('… +3 more');
    expect(directoryListing(['a.ts', 'lib/'])).toBe('a.ts\nlib/');
  });
});

describe('attaching the mentioned files', () => {
  it('attaches the content of each mentioned file as one part', async () => {
    const host = fakeHost({ 'a.ts': 'x\ny\n' });
    expect(await attachMentions('read @a.ts', host)).toEqual({ attachments: [{ type: 'attached_file', path: 'a.ts', content: '     1\tx\n     2\ty', truncated: false }], images: [] });
  });

  it('leaves a token that names nothing as plain text', async () => {
    expect(await attachMentions('ask @someone about it', fakeHost({}))).toEqual({ attachments: [], images: [] });
  });

  it('does not read a path a rule denies and tells the model and the user', async () => {
    const host = fakeHost({ '.env': { bytes: encoder.encode('SECRET=1'), floor: 'denied' } });
    expect(await attachMentions('@.env', host)).toEqual({
      attachments: [
        {
          type: 'attachment_note',
          path: '.env',
          text: 'The user referenced .env, which cannot be attached (a deny rule or a protected path covers it; /permissions shows the rules). Do not try to read it unless asked.',
          shown: '.env: not attached (a deny rule or a protected path covers it; /permissions shows the rules)',
        },
      ],
      images: [],
    });
    expect(host.reads).toEqual([]);
  });

  it('does not attach a path that leaves the allowed roots', async () => {
    const host = fakeHost({ '../outside.txt': { outside: true } });
    const { attachments } = await attachMentions('@../outside.txt', host);
    expect(attachments).toEqual([
      {
        type: 'attachment_note',
        path: '../outside.txt',
        text: 'The user referenced ../outside.txt, which cannot be attached (it is outside this folder; /permissions adds another folder the session may read). Do not try to read it unless asked.',
        shown: '../outside.txt: not attached (it is outside this folder; /permissions adds another folder the session may read)',
      },
    ]);
    expect(host.reads).toEqual([]);
  });

  it('attaches nothing in an untrusted project', async () => {
    const host = fakeHost({ 'a.ts': 'x' }, { trusted: false });
    const { attachments } = await attachMentions('@a.ts', host);
    expect(attachments).toEqual([
      {
        type: 'attachment_note',
        path: 'a.ts',
        text: 'The user referenced a.ts, which cannot be attached (this folder is not trusted; /permissions trusts it). Do not try to read it unless asked.',
        shown: 'a.ts: not attached (this folder is not trusted; /permissions trusts it)',
      },
    ]);
    expect(host.reads).toEqual([]);
  });

  it('attaches a file of exactly the file share and refuses one token more', async () => {
    const fits = '     1\t'.length;
    const host = fakeHost({ 'fit.txt': 'a'.repeat(100 - fits), 'over.txt': 'a'.repeat(101 - fits) });
    const { attachments } = await attachMentions('@fit.txt @over.txt', host);
    expect(attachments[0]).toMatchObject({ type: 'attached_file', path: 'fit.txt' });
    expect(attachments[1]).toEqual({
      type: 'attachment_note',
      path: 'over.txt',
      text: 'Note: over.txt is about 101 tokens, more than the 100 tokens that fit with the rest of the context. It was not attached. Read the range you need with the read tool.',
      shown: 'over.txt: too large to attach (101 tokens > 100); the model was told to read what it needs',
    });
  });

  it('treats a mention that would pass the message total as too large, in the order written', async () => {
    const body = 'a'.repeat(100 - '     1\t'.length);
    const host = fakeHost({ '1.txt': body, '2.txt': body, '3.txt': body, 'small.txt': 'a'.repeat(50 - '     1\t'.length) });
    const { attachments } = await attachMentions('@1.txt @2.txt @3.txt @small.txt', host);
    expect(attachments.map((part) => part.type)).toEqual(['attached_file', 'attached_file', 'attachment_note', 'attached_file']);
    expect(attachments[2]).toMatchObject({ shown: '3.txt: too large to attach (100 tokens > 50); the model was told to read what it needs' });
  });

  it('does not read a file whose size is more than four times the file share in bytes', async () => {
    const host = fakeHost({ 'big.bin': { bytes: new Uint8Array(0), size: 1601 } });
    const { attachments } = await attachMentions('@big.bin', host);
    expect(attachments).toEqual([
      {
        type: 'attachment_note',
        path: 'big.bin',
        text: 'Note: big.bin is about 401 tokens, more than the 100 tokens that fit with the rest of the context. It was not attached. Read the range you need with the read tool.',
        shown: 'big.bin: too large to attach (401 tokens > 100); the model was told to read what it needs',
      },
    ]);
    expect(host.reads).toEqual([]);
  });

  it('attaches at most 16 files to one message', async () => {
    const names = Array.from({ length: ATTACH_MAX_FILES + 1 }, (_unused, index) => `f${index}.txt`);
    const host = fakeHost(Object.fromEntries(names.map((name) => [name, 'a'])), { ceiling: 100_000 });
    const { attachments } = await attachMentions(names.map((name) => `@${name}`).join(' '), host);
    expect(attachments.filter((part) => part.type === 'attached_file')).toHaveLength(ATTACH_MAX_FILES);
    expect(attachments.at(-1)).toEqual({
      type: 'attachment_note',
      path: 'f16.txt',
      text: 'Note: f16.txt was not attached: at most 16 files are attached to one message. Read it with the read tool.',
      shown: 'f16.txt: not attached (at most 16 files per message)',
    });
    expect(host.reads).toHaveLength(ATTACH_MAX_FILES);
  });

  it('refuses a file with a NUL byte and one that is not UTF-8', async () => {
    const host = fakeHost({ 'nul.dat': { bytes: new Uint8Array([97, 0, 98]) }, 'latin.txt': { bytes: new Uint8Array([0xff, 0xfe, 0x41]) } });
    const { attachments } = await attachMentions('@nul.dat @latin.txt', host);
    expect(attachments).toEqual([
      { type: 'attachment_note', path: 'nul.dat', text: 'nul.dat is not a text file', shown: 'nul.dat is not a text file' },
      { type: 'attachment_note', path: 'latin.txt', text: 'latin.txt is not a text file', shown: 'latin.txt is not a text file' },
    ]);
  });

  it('lets an abort or a defect of the read reach the caller instead of a note', async () => {
    const ended = new Error('the request ended');
    const failing = async (): Promise<never> => {
      throw ended;
    };
    const file = fakeHost({ 'a.txt': { bytes: new TextEncoder().encode('a') } }, { read: failing });
    await expect(attachMentions('@a.txt', file)).rejects.toBe(ended);
    const folder = fakeHost({ src: { directory: ['a.ts'] } }, { list: failing });
    await expect(attachMentions('@src', folder)).rejects.toBe(ended);
  });

  it('turns a failed read into a note, never a failure', async () => {
    const host = fakeHost({ 'locked.txt': { bytes: new Uint8Array(0), unreadable: true } });
    const { attachments } = await attachMentions('@locked.txt', host);
    expect(attachments).toEqual([
      {
        type: 'attachment_note',
        path: 'locked.txt',
        text: 'The user referenced locked.txt, which cannot be attached (it could not be read). Do not try to read it unless asked.',
        shown: 'locked.txt: not attached (it could not be read)',
      },
    ]);
  });

  it('attaches a directory as a listing', async () => {
    const host = fakeHost({ src: { directory: ['app.tsx', 'screen/'] } });
    expect((await attachMentions('@src', host)).attachments).toEqual([{ type: 'attached_file', path: 'src/', content: 'app.tsx\nscreen/', truncated: false }]);
  });

  it('sends an image file as an image when the model accepts images and as a note when it does not', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const accepted = await attachMentions('@shot.png', fakeHost({ 'shot.png': { bytes: png } }, { imageInput: true }));
    expect(accepted).toEqual({ attachments: [], images: [{ mediaType: 'image/png', data: Buffer.from(png).toString('base64') }] });
    const refused = await attachMentions('@shot.png', fakeHost({ 'shot.png': { bytes: png } }));
    expect(refused.attachments).toEqual([{ type: 'attachment_note', path: 'shot.png', text: 'shot.png is not a text file', shown: 'shot.png is not a text file' }]);
  });
});
