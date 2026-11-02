import { waitFor } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { UPDATE_CHECK_COMMAND, announceUpdate, runBackgroundCheck, startBackgroundCheck } from '../src/update/background.ts';
import { assetNameFor } from '../src/update/source.ts';
import { NEW_BINARY, OLD_BINARY, PUBLIC_KEY, setupUpdate } from './update-harness.ts';
import type { HarnessOptions, UpdateHarness } from './update-harness.ts';

const interrupt = (): AbortSignal => new AbortController().signal;

const publish = (harness: UpdateHarness, tag = 'v2.0.0'): void => {
  harness.server.publish(tag, { [assetNameFor(harness.ports.platform, harness.ports.arch)]: NEW_BINARY });
};

describe('startBackgroundCheck: what the user command does', () => {
  it('spawns the detached update-check from this executable on the first run and returns without waiting for it', async (context) => {
    const harness = await setupUpdate(context);

    await startBackgroundCheck(harness.wiring);

    expect(harness.spawned.map((child) => [child.spec.command, child.spec.args])).toEqual([[harness.target, [UPDATE_CHECK_COMMAND]]]);
    expect(harness.spawned[0]?.spec.cwd).toBe(harness.ports.home);
    expect(harness.server.requests).toEqual([]);
    expect(harness.stderr).toEqual([]);
  });

  it('does not spawn again before the interval has passed, and does after it', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'up_to_date' }, announced: true };

    await startBackgroundCheck(harness.wiring);
    expect(harness.spawned).toHaveLength(0);

    await harness.ports.clock.sleep(harness.wiring.checkIntervalMs - 1);
    await startBackgroundCheck(harness.wiring);
    expect(harness.spawned).toHaveLength(0);

    await harness.ports.clock.sleep(1);
    await startBackgroundCheck(harness.wiring);
    expect(harness.spawned).toHaveLength(1);
  });

  it('does not spawn another check while one holds the update lock, because it has not recorded anything yet', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.lockHeld = true;

    await startBackgroundCheck(harness.wiring);

    expect(harness.spawned).toEqual([]);
    expect(harness.released.count).toBe(0);
  });

  it('decides whether a check is running without taking the update lock, so it cannot make a concurrent update fail', async (context) => {
    const harness = await setupUpdate(context);
    let acquisitions = 0;
    const acquire = harness.ports.lock.acquire;
    harness.ports.lock.acquire = async () => {
      acquisitions += 1;
      return acquire();
    };

    await startBackgroundCheck(harness.wiring);

    expect(harness.spawned).toHaveLength(1);
    expect(acquisitions).toBe(0);
  });

  it('treats a check time in the future as due', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 10_000_000, outcome: { kind: 'up_to_date' }, announced: true };

    await startBackgroundCheck(harness.wiring);

    expect(harness.spawned).toHaveLength(1);
  });

  it('does nothing when autoUpdates is off', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.autoUpdates = false;
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    await startBackgroundCheck(harness.wiring);

    expect(harness.spawned).toHaveLength(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.state.writes).toEqual([]);
  });

  const inapplicable: readonly [string, HarnessOptions][] = [
    ['a build run from source', { scripted: true }],
    ['a build without an update source', { build: { repo: undefined, teamId: undefined, publicKey: undefined } }],
    ['a platform without a release asset', { platform: 'win32' }],
  ];
  for (const [label, options] of inapplicable) {
    it(`does nothing for ${label}`, async (context) => {
      const harness = await setupUpdate(context, options);
      harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

      await startBackgroundCheck(harness.wiring);

      expect(harness.spawned).toHaveLength(0);
      expect(harness.stderr).toEqual([]);
      expect(harness.state.writes).toEqual([]);
    });
  }

  it('surfaces a malformed build input instead of skipping silently', async (context) => {
    const harness = await setupUpdate(context, { build: { repo: 'no-slash', teamId: undefined, publicKey: PUBLIC_KEY } });

    await expect(startBackgroundCheck(harness.wiring)).rejects.toMatchObject({ code: 'invalid_update_source' });
  });

  it('returns an installed update once for the caller to show and marks it announced', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    expect(await announceUpdate(harness.wiring)).toBe('momonga 2.0.0 was installed in the background; you are running 1.0.0');
    expect(await announceUpdate(harness.wiring)).toBeUndefined();

    expect(harness.stderr).toEqual([]);
    expect(harness.state.value).toEqual({ checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: true });
  });

  it('returns an update of the running version as an update', async (context) => {
    const harness = await setupUpdate(context, { version: '2.0.0' });
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    expect(await announceUpdate(harness.wiring)).toBe('momonga was updated to 2.0.0 in the background');
  });

  it('returns a failed check with its code and the command that explains it', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'failed', code: 'checksum_mismatch', message: 'sha256 differs' }, announced: false };

    expect(await announceUpdate(harness.wiring)).toBe('the background update check failed (checksum_mismatch): sha256 differs; run `momonga update` for details');
  });

  it('stays quiet about an up-to-date result', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'up_to_date' }, announced: false };

    expect(await announceUpdate(harness.wiring)).toBeUndefined();
  });

  it('leaves an unannounced result for the announcement when it schedules the check', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    await startBackgroundCheck(harness.wiring);

    expect(harness.stderr).toEqual([]);
    expect(harness.state.value).toEqual({ checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false });
  });

  it('announces nothing when autoUpdates is off', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.autoUpdates = false;
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    expect(await announceUpdate(harness.wiring)).toBeUndefined();
  });

  it('rejects a state file it cannot read rather than ignoring it', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 'yesterday' };

    await expect(startBackgroundCheck(harness.wiring)).rejects.toThrow('the update state file is not valid');
    expect(harness.spawned).toHaveLength(0);
  });

  it('reports on stderr a detached check that could not be started, without failing the command', async (context) => {
    const harness = await setupUpdate(context);

    await startBackgroundCheck(harness.wiring);
    harness.spawned[0]?.reject(new Error('spawn ENOENT'));
    await waitFor(() => harness.stderr.length > 0, { description: 'the spawn failure report' });

    expect(harness.stderr).toEqual(['momonga: the background update check could not run: spawn ENOENT\n']);
  });
});

describe('runBackgroundCheck: the detached check itself', () => {
  it('installs a newer release without touching the daemon and records it for announcement', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.daemonRunning = true;
    publish(harness);
    await harness.ports.clock.sleep(5);

    expect(await runBackgroundCheck(harness.wiring, interrupt())).toBe(0);

    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
    expect(harness.runs.some((call) => call.args[0] === 'daemon')).toBe(false);
    expect(harness.state.value).toEqual({ checkedAt: 5, outcome: { kind: 'installed', version: '2.0.0' }, announced: false });
  });

  it('records an up-to-date result as already announced', async (context) => {
    const harness = await setupUpdate(context, { version: '2.0.0' });
    publish(harness);

    await runBackgroundCheck(harness.wiring, interrupt());

    expect(harness.state.value).toEqual({ checkedAt: 0, outcome: { kind: 'up_to_date' }, announced: true });
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
  });

  it('treats a release older than the running version as up to date instead of failing', async (context) => {
    const harness = await setupUpdate(context, { version: '3.0.0' });
    publish(harness);

    expect(await runBackgroundCheck(harness.wiring, interrupt())).toBe(0);

    expect(harness.state.value).toMatchObject({ outcome: { kind: 'up_to_date' } });
  });

  it('records a failure with its typed code and then fails the process', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetNameFor(harness.ports.platform, harness.ports.arch)]: NEW_BINARY }, { checksums: 'f'.repeat(64) + '  other\n' });

    await expect(runBackgroundCheck(harness.wiring, interrupt())).rejects.toMatchObject({ code: 'checksum_entry_missing' });

    expect(harness.state.value).toMatchObject({
      outcome: { kind: 'failed', code: 'checksum_entry_missing' },
      announced: false,
    });
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
  });

  it('records an untyped failure as unexpected', async (context) => {
    const harness = await setupUpdate(context);
    harness.ports.http = {
      get: async () => {
        throw new TypeError('boom');
      },
    };

    await expect(runBackgroundCheck(harness.wiring, interrupt())).rejects.toMatchObject({ code: 'release_lookup_failed' });

    expect(harness.state.value).toMatchObject({ outcome: { kind: 'failed', code: 'release_lookup_failed' } });
  });

  it('leaves everything alone and succeeds when another update holds the lock', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    harness.control.lockHeld = true;

    expect(await runBackgroundCheck(harness.wiring, interrupt())).toBe(0);

    expect(harness.server.requests).toEqual([]);
    expect(harness.state.writes).toEqual([]);
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
  });
});
