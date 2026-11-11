import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_PATH, resolveSegmentProgram } from '../src/program-resolution.ts';
import { analyzeCommand, allWriteTargets } from '../src/shell.ts';
import type { Segment } from '../src/shell.ts';
import { DEFAULT_COMMAND_PATH_VALUE } from './decision-rows.ts';
import { TEST_SEARCH_PATH, fakeFs, isWritableFor } from './helpers.ts';
import type { FakeFsLayout } from './helpers.ts';
import { fakePolicyFilesystem } from '@momonga/testkit';

const CWD = '/w/project';

const segmentOf = (command: string): Segment => {
  const [segment] = analyzeCommand(command)?.segments ?? [];
  if (segment === undefined) throw new Error(`no segment in ${command}`);
  return segment;
};

const resolve = async (command: string, layout: FakeFsLayout = {}) => {
  const filesystem = fakePolicyFilesystem(layout);
  const result = await resolveSegmentProgram(segmentOf(command), { fs: filesystem, cwd: CWD, searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([CWD]) });
  return { result, calls: filesystem.resolveCalls };
};

describe('resolveSegmentProgram (3.13)', () => {
  it('walks a word containing / through its links and does not consult the port', async () => {
    expect((await resolve('./sed -n p f')).calls).toEqual([]);
    expect((await resolve('./sed -n p f')).result).not.toEqual({ program: '/usr/bin/sed' });
    expect((await resolve('/opt/homebrew/bin/sed -n p f')).result).toEqual({ program: '/opt/homebrew/bin/sed' });
    expect((await resolve('/usr/bin/../bin/sed -n p f')).result).toEqual({ program: '/usr/bin/sed' });
  });

  it('resolves a bare name through the port with the search path and the writable check', async () => {
    const { result, calls } =await  await resolve('sed -n p f');
    expect(result).toEqual({ program: '/usr/bin/sed' });
    expect(calls.map(({ name, cwd, searchPath }) => ({ name, cwd, searchPath }))).toEqual([{ name: 'sed', cwd: CWD, searchPath: TEST_SEARCH_PATH }]);
    expect(calls[0]?.isWritable(`${CWD}/bin`)).toBe(true);
    expect(calls[0]?.isWritable('/opt/homebrew/bin')).toBe(false);
  });

  it.each(['PATH=/x sed -n p f', 'env PATH=/x sed -n p f', 'env -P /x sed -n p f', 'env -i sed -n p f', 'sudo sed -n p f', 'flock l sed -n p f'])(
    'leaves %s unresolved',
    async (command) => {
      expect((await resolve(command)).result).toEqual({ none: true });
    },
  );

  it('resolves through a stripped wrapper and plain env', async () => {
    expect((await resolve('nice -n 5 sed -n p f')).result).toEqual({ program: '/usr/bin/sed' });
    expect((await resolve('env sed -n p f')).result).toEqual({ program: '/usr/bin/sed' });
  });

  it('resolves command -p sed through DEFAULT_COMMAND_PATH, also when the search path holds a Homebrew sed', async () => {
    expect(DEFAULT_COMMAND_PATH).toBe(DEFAULT_COMMAND_PATH_VALUE);
    const layout: FakeFsLayout = { programs: { sed: '/opt/homebrew/bin/sed' }, programsBySearchPath: { [DEFAULT_COMMAND_PATH_VALUE]: { sed: '/usr/bin/sed' } } };
    const { result, calls } =await  await resolve('command -p sed -n p f', layout);
    expect(result).toEqual({ program: '/usr/bin/sed' });
    expect(calls.map((call) => call.searchPath)).toEqual([DEFAULT_COMMAND_PATH_VALUE]);
    expect((await resolve('sed -n p f', layout)).result).toEqual({ program: '/opt/homebrew/bin/sed' });
  });

  it('does not strip the query form command -pv sed', async () => {
    const { result, calls } =await  await resolve('command -pv sed');
    expect(result).not.toEqual({ program: '/usr/bin/sed' });
    expect(calls.some((call) => call.name === 'sed')).toBe(false);
  });
});

describe('the sed extractor takes the same resolution as approval', () => {
  const targets = (command: string, program: string | undefined) => {
    const analysis = analyzeCommand(command);
    return allWriteTargets(analysis as NonNullable<typeof analysis>, () => program);
  };

  it('reads sed -i s/a/b/ g the Darwin way only for /usr/bin/sed', () => {
    expect(targets('sed -i s/a/b/ g', '/usr/bin/sed')).toEqual([]);
    expect(targets('sed -i s/a/b/ g', '/opt/homebrew/bin/sed')).toContainEqual({ literal: 'g' });
    expect(targets('sed -i s/a/b/ g', undefined)).toContainEqual({ literal: 'g' });
  });

  it('decides with the resolution of each segment', async () => {
    const analysis = analyzeCommand('sed -i s/a/b/ g; ./sed -i s/a/b/ h');
    const programs = new Map<Segment, string | undefined>();
    for (const segment of (analysis as NonNullable<typeof analysis>).segments) {
      const result = await resolveSegmentProgram(segment, { fs: fakeFs(), cwd: CWD, searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([CWD]) });
      programs.set(segment, 'program' in result ? result.program : undefined);
    }
    const resolveFor = (segment: Segment): string | undefined => programs.get(segment);
    const found = allWriteTargets(analysis as NonNullable<typeof analysis>, resolveFor);
    expect(found).not.toContainEqual({ literal: 'g' });
    expect(found).toContainEqual({ literal: 'h' });
  });
});

describe('Stage D resolution rules', () => {
  it('leaves a relative word unresolved and walks an absolute one', async () => {
    expect((await resolve('./sed -n p f')).result).not.toEqual({ program: '/usr/bin/sed' });
    expect((await resolve('/usr/bin/../bin/ls')).result).toEqual({ program: '/usr/bin/ls' });
  });

  it('applies command -p only to the word after it', async () => {
    const { calls } = await resolve('command -p nice sed -n p f');
    expect(calls.map(({ name, searchPath }) => ({ name, searchPath }))).toEqual([
      { name: 'nice', searchPath: DEFAULT_COMMAND_PATH_VALUE },
      { name: 'sed', searchPath: TEST_SEARCH_PATH },
    ]);
  });

  it('gives none when the fake port gives none for a dotted spelling', async () => {
    expect((await resolve('sed -n p f', { programs: {} })).result).toEqual({ none: true });
  });
});
