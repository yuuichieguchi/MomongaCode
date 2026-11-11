import fs from 'node:fs';
import path from 'node:path';
import { withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_DOCUMENT_MAX_BYTES, createMemoryCredentialStore, nodeFileSystem } from '@momonga/foundation';
import { readActivePointer } from '../src/plan/active-account.ts';
import { catalogKey, createPlanCatalog } from '../src/plan/catalog.ts';
import { ensureHostIdentity } from '../src/plan/host-identity.ts';
import { NOT_VALID_JSON, parsePlanJson } from '../src/plan/plan-json.ts';
import { PROFILE_ID, recordKey, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const LEAKED = 'leaked-file-text';

const DEPTH = 5000;

const DEEP = `${'{"a":'.repeat(DEPTH)}"${LEAKED}"${'}'.repeat(DEPTH)}`;

const BROKEN = `{"a":${LEAKED}}`;

const OVER_CAP = `{"a":"${'x'.repeat(AUTH_DOCUMENT_MAX_BYTES)}"}`;

const CAP_TEXT = `it is larger than ${AUTH_DOCUMENT_MAX_BYTES} bytes`;

const RESET_ADVICE = 'run `momonga auth reset-host` to create a new host identity';

const signal = (): AbortSignal => new AbortController().signal;

const thrownBy = (call: () => unknown): unknown => {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
};

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

const messageOf = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);

const privateFile = (context: TestContext, name: string, text: string): string => {
  const file = path.join(withTempDir(context), name);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
};

describe('parsePlanJson, the one parser of the stored plan files (A6)', () => {
  it('gives the value of a text that is JSON within the depth limit', () => {
    expect(parsePlanJson('{"a":[1,{"b":null}]}', (problem) => new Error(`the file ${problem}`))).toEqual({ a: [1, { b: null }] });
  });

  it.for([
    { name: 'a text that is not JSON', text: BROKEN },
    { name: `a text nested ${DEPTH} deep`, text: DEEP },
    { name: 'an empty text', text: '' },
  ])('refuses $name with the one problem, and the error holds nothing of the text', ({ text }) => {
    const error = thrownBy(() => parsePlanJson(text, (problem) => new Error(`the file ${problem}`)));
    expect(messageOf(error)).toBe('the file is not valid JSON');
    expect(error instanceof Error ? error.cause : 'no error').toBeUndefined();
    expect(NOT_VALID_JSON).toBe('is not valid JSON');
  });
});

describe('each of the four stored plan files that fails the parser for any reason, depth included, is "... is not valid JSON" (A6, BM2)', () => {
  it.for([
    { name: 'not JSON', text: BROKEN },
    { name: `nested ${DEPTH} deep`, text: DEEP },
  ])('the session record: $name', async ({ text }) => {
    const h = await harness();
    await signedIn(h, 'work');
    await h.store.write(recordKey('work'), text, signal());
    const work = { profile: PROFILE_ID, account: 'work' };
    await h.reopen({ accounts: [work] });
    const source = h.sessions.authSource(work);
    const failure = await rejectionOf(source.read(signal()));
    expect(messageOf(failure)).toBe('the plan record is not valid JSON');
    expect(source.status()).toEqual({ state: 'store_unreadable', cause: 'the plan record is not valid JSON' });
    expect(h.warnings).toContain(`the plan session of ${PROFILE_ID} account work cannot be read: the plan record is not valid JSON`);
    expect(JSON.stringify(h.warnings)).not.toContain(LEAKED);
  });

  it.for([
    { name: 'not JSON', text: BROKEN },
    { name: `nested ${DEPTH} deep`, text: DEEP },
  ])('the catalog record: $name', async ({ text }) => {
    const h = await harness();
    const store = createMemoryCredentialStore();
    await store.write(catalogKey(PROFILE_ID, 'work'), text, signal());
    const catalog = createPlanCatalog({
      store,
      clock: h.clock,
      outbound: () => Promise.reject(new Error('the stored record is refused before any send')),
      sleep: () => Promise.resolve(),
    });
    const failure = await rejectionOf(catalog.record(PROFILE_ID, 'work', signal()));
    expect(failure).toMatchObject({ code: 'plan_store_unreadable', message: `the plan model list of ${PROFILE_ID} account work cannot be read: the plan catalog record is not valid JSON` });
  });

  it.for([
    { name: 'not JSON', text: BROKEN },
    { name: `nested ${DEPTH} deep`, text: DEEP },
  ])('the active account pointer: $name', async ({ text }, context) => {
    const file = privateFile(context, 'plan-active.json', text);
    expect(messageOf(await rejectionOf(readActivePointer(nodeFileSystem, file)))).toBe(`the active plan account file ${file} is not valid JSON`);
  });

  it.for([
    { name: 'not JSON', text: BROKEN },
    { name: `nested ${DEPTH} deep`, text: DEEP },
  ])('the host identity: $name', async ({ text }, context) => {
    const file = privateFile(context, 'plan-host.json', text);
    expect(messageOf(await rejectionOf(ensureHostIdentity(nodeFileSystem, file, { accountsExist: true })))).toBe(`the plan host identity file ${file} is not valid JSON; ${RESET_ADVICE}`);
  });
});

describe("the pointer and the host identity are read with the store's size cap (N-E11)", () => {
  it('a pointer over the cap is refused with the cap text', async (context) => {
    const file = privateFile(context, 'plan-active.json', OVER_CAP);
    expect(messageOf(await rejectionOf(readActivePointer(nodeFileSystem, file)))).toBe(`could not read the active plan account file ${file}: ${CAP_TEXT}`);
  });

  it('a host identity over the cap is refused with the cap text', async (context) => {
    const file = privateFile(context, 'plan-host.json', OVER_CAP);
    expect(messageOf(await rejectionOf(ensureHostIdentity(nodeFileSystem, file, { accountsExist: true })))).toBe(`the plan host identity file ${file} cannot be read (${CAP_TEXT}); ${RESET_ADVICE}`);
  });

  it('a pointer that does not exist is an empty pointer, and one under the cap is read', async (context) => {
    const directory = withTempDir(context);
    expect(await readActivePointer(nodeFileSystem, path.join(directory, 'absent.json'))).toEqual({});
    const file = path.join(directory, 'plan-active.json');
    fs.writeFileSync(file, JSON.stringify({ [PROFILE_ID]: 'work' }), { mode: 0o600 });
    expect(await readActivePointer(nodeFileSystem, file)).toEqual({ [PROFILE_ID]: 'work' });
  });
});

describe('the stored plan files have one parser (single definition)', () => {
  const PLAN_SOURCE = path.resolve(import.meta.dirname, '../src/plan');
  const sources = fs.readdirSync(PLAN_SOURCE).map((name) => ({ name, text: fs.readFileSync(path.join(PLAN_SOURCE, name), 'utf8') }));

  it('no file of the plan code calls JSON.parse, and the text "is not valid JSON" is written in plan-json.ts only', () => {
    expect(sources.filter((source) => source.text.includes('JSON.parse(')).map((source) => source.name)).toEqual([]);
    expect(sources.filter((source) => source.text.includes('is not valid JSON')).map((source) => source.name)).toEqual(['plan-json.ts']);
  });

  it('the record, the catalog, the pointer and the host identity parse through parsePlanJson', () => {
    expect(sources.filter((source) => source.text.includes('parsePlanJson(') && source.name !== 'plan-json.ts').map((source) => source.name).sort()).toEqual(['active-account.ts', 'catalog.ts', 'host-identity.ts', 'session.ts']);
  });
});
