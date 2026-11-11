import { START_FAILURE_REASONS } from '../../foundation/src/generation-start.ts';
import type { StartFailureReason } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { daemonNotStartedText, needsDetail, startFailureText } from '../src/daemon/start-failure.ts';
import type { StartFailure } from '../src/daemon/start-failure.ts';

const LOG_FILE = '/home/me/.momonga/logs/supervisor.log';
const INTERNAL_WORDS = /generation|supervisor|background service|start record|promoted|abandoned|director/i;
const WAY_FORWARD = /(?: Run the command again\.| The reason is in \/home\/me\/\.momonga\/logs\/supervisor\.log\.|, then run the command again\.)$/;

const failureOf = (reason: StartFailureReason): StartFailure => (needsDetail(reason) ? { reason, detail: 'DETAIL' } : { reason });

describe('the text of a daemon start that failed', () => {
  it.each(START_FAILURE_REASONS)('states %s in public words and ends with one way forward', (reason) => {
    const text = startFailureText({ version: '1.2.3', failure: failureOf(reason), serving: undefined, logFile: LOG_FILE });

    expect(text.startsWith('The new daemon (v1.2.3) did not start (')).toBe(true);
    expect(text.replace(LOG_FILE, '')).not.toMatch(INTERNAL_WORDS);
    expect(text).toMatch(WAY_FORWARD);
    expect(text).not.toContain('undefined');
  });

  it('gives each reason a text of its own', () => {
    const texts = START_FAILURE_REASONS.map((reason) => startFailureText({ version: '1.2.3', failure: failureOf(reason), serving: undefined, logFile: LOG_FILE }));

    expect(new Set(texts).size).toBe(START_FAILURE_REASONS.length);
  });

  it('carries the detail of a reason that has one', () => {
    for (const reason of START_FAILURE_REASONS.filter(needsDetail)) {
      expect(startFailureText({ version: '1.2.3', failure: { reason, detail: 'DETAIL' }, serving: undefined, logFile: LOG_FILE })).toContain('DETAIL');
    }
  });

  it('says which version keeps running when one does', () => {
    expect(startFailureText({ version: '1.2.3', failure: { reason: 'stopped-before-ready' }, serving: '1.2.2', logFile: LOG_FILE })).toBe(
      `The new daemon (v1.2.3) did not start (it stopped before it was ready); v1.2.2 keeps running. The reason is in ${LOG_FILE}.`,
    );
  });

  it('is the one sentence the update prints for its own reasons', () => {
    expect(daemonNotStartedText('2.0.0', 'exit code 1', '1.0.0')).toBe('The new daemon (v2.0.0) did not start (exit code 1); v1.0.0 keeps running.');
    expect(daemonNotStartedText('2.0.0', 'exit code 1', undefined)).toBe('The new daemon (v2.0.0) did not start (exit code 1).');
  });
});
