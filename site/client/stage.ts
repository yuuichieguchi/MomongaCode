export type StageClock = {
  schedule(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
};

export type StageElement = {
  setWag(kind: string | undefined): void;
  reflow(): void;
  onClick(listener: () => void): void;
};

export const STAGE_WAG_MS = 1800;

const DEFAULT_CLOCK: StageClock = {
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (timer) => clearTimeout(timer),
};

export const wireStage = (
  stage: StageElement,
  reducedMotion: () => boolean,
  clock: StageClock = DEFAULT_CLOCK,
): (() => void) => {
  let restore: ReturnType<typeof setTimeout> | undefined;
  const celebrate = (kind: string): void => {
    if (reducedMotion()) return;
    if (restore !== undefined) {
      clock.cancel(restore);
      stage.setWag(undefined);
      stage.reflow();
    }
    stage.setWag(kind);
    restore = clock.schedule(() => {
      restore = undefined;
      stage.setWag(undefined);
    }, STAGE_WAG_MS);
  };
  stage.onClick(() => celebrate('tap'));
  return () => celebrate('copied');
};
