import { planProfileOf } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';
import { createFakeClock } from '@momonga/testkit';
import type { PlanFetch, PlanSleep } from '../src/plan/refresh.ts';
import { START_MS } from './plan-support.ts';

export const CHUNK_BYTES = 1024;
export const ATTEMPT_BOUND_MS = 15_000;
export const ISSUER = 'https://auth.plan.test';
export const TOKEN_URL = `${ISSUER}/oauth/token`;
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const REVOKE_URL = `${ISSUER}/oauth/revoke`;
export const WAIT_POLICY = { totalWaitMs: 60_000, baseMs: 100, maxMs: 1000, random: () => 0.5 };

export const sendProfile = (): PlanProfile => {
  const shipped = planProfileOf('chatgpt');
  return { ...shipped, oauth: { ...shipped.oauth!, issuer: ISSUER, discoveryUrl: DISCOVERY_URL, tokenUrl: TOKEN_URL } };
};

export const sendClock = () => createFakeClock(START_MS);

export type PulledBody = { response: Response; pulled(): number };

export const streamedBody = (status: number, totalBytes: number, headers: Record<string, string> = {}): PulledBody => {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_BYTES, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { response: new Response(stream, { status, headers }), pulled: () => sent };
};

export type RecordedFetch = { fetch: PlanFetch; calls: Array<{ url: string; init: RequestInit }> };

export const recordedFetch = (answer: (url: string, init: RequestInit, index: number) => Promise<Response> | Response): RecordedFetch => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(url, init, calls.length - 1);
    },
  };
};

export type ParkedSleep = { sleep: PlanSleep; backoffs: Array<{ ms: number; signal: AbortSignal | undefined }>; parkBackoffs: boolean };

export const boundOnlySleep = (options: { parkBackoffs: boolean }): ParkedSleep => {
  const parked: ParkedSleep = {
    parkBackoffs: options.parkBackoffs,
    backoffs: [],
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (ms === ATTEMPT_BOUND_MS) return;
        parked.backoffs.push({ ms, signal });
        if (!parked.parkBackoffs) resolve();
      }),
  };
  return parked;
};
