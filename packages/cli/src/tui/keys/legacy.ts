import type { Key } from 'ink';
import type { KeyEvent, KeyName } from '../terminal/events.ts';

export type LegacyKey = { input: string; key: Key };

export const legacyKeyOf = (event: KeyEvent): LegacyKey => {
  const named = (name: KeyName): boolean => 'name' in event && event.name === name;
  return {
    input: 'text' in event ? event.text : '',
    key: {
      upArrow: named('up'),
      downArrow: named('down'),
      leftArrow: named('left'),
      rightArrow: named('right'),
      pageDown: named('pagedown'),
      pageUp: named('pageup'),
      home: named('home'),
      end: named('end'),
      return: named('enter'),
      escape: named('escape'),
      tab: named('tab'),
      backspace: named('backspace'),
      delete: named('delete'),
      ctrl: event.ctrl,
      shift: event.shift,
      meta: event.alt,
      super: false,
      hyper: false,
      capsLock: false,
      numLock: false,
    },
  };
};
