export type ClipboardWriter = (text: string) => Promise<void>;

export type CopyClock = {
  schedule(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
};

export type CopyTarget = {
  show(): void;
  setDone(done: boolean): void;
  setStatus(text: string): void;
  onClick(listener: () => void): void;
  code(): string;
};

export const COPIED_SHOWN_MS = 2000;

export const clipboardWriter = (clipboard: { writeText?: unknown } | null | undefined): ClipboardWriter | undefined => {
  if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== 'function') return undefined;
  const write = clipboard.writeText as (text: string) => Promise<void>;
  return (text: string) => write.call(clipboard, text);
};

const DEFAULT_CLOCK: CopyClock = {
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (timer) => clearTimeout(timer),
};

export const wireCopyButtons = (
  targets: readonly CopyTarget[],
  write: ClipboardWriter | undefined,
  copiedLabel: string,
  report: (error: unknown) => void,
  clock: CopyClock = DEFAULT_CLOCK,
): void => {
  if (write === undefined) return;
  for (const target of targets) {
    target.show();
    let restore: ReturnType<typeof setTimeout> | undefined;
    const showCopied = (): void => {
      target.setDone(true);
      target.setStatus(copiedLabel);
      if (restore !== undefined) clock.cancel(restore);
      restore = clock.schedule(() => {
        restore = undefined;
        target.setDone(false);
        target.setStatus('');
      }, COPIED_SHOWN_MS);
    };
    target.onClick(() => {
      try {
        write(target.code()).then(showCopied, report);
      } catch (error) {
        report(error);
      }
    });
  }
};
