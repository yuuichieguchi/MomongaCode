import { createContext, useEffect, useRef, useState } from 'react';
import { TAIL_WAG_FRAMES, TAIL_WAG_MS } from '../figure.ts';
import type { ScreenTimers } from './timers.ts';

export type TailPose = { swung(): boolean; subscribe(listener: () => void): () => void };

const RESTING: TailPose = { swung: () => false, subscribe: () => () => undefined };

export const TailPoseContext = createContext<TailPose>(RESTING);

type SettableTailPose = TailPose & { set(swung: boolean): void };

const settableTailPose = (): SettableTailPose => {
  let swung = false;
  const listeners = new Set<() => void>();
  return {
    swung: () => swung,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      if (next === swung) return;
      swung = next;
      for (const listener of listeners) listener();
    },
  };
};

export const useTailWag = (wanted: boolean, timers: ScreenTimers): TailPose => {
  const [pose] = useState(settableTailPose);
  const wagged = useRef(false);
  useEffect(() => {
    if (!wanted || wagged.current) return undefined;
    wagged.current = true;
    let handle: unknown;
    const turn = (frame: number): void => {
      handle = timers.setTimeout(() => {
        pose.set(frame % 2 === 1);
        if (frame < TAIL_WAG_FRAMES) turn(frame + 1);
      }, TAIL_WAG_MS);
    };
    turn(1);
    return () => {
      timers.clearTimeout(handle);
      pose.set(false);
    };
  }, [wanted, timers, pose]);
  return pose;
};
