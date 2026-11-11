import { describe, expect, it } from 'vitest';
import { defaultContextSettings } from '@momonga/config';
import { createFakeSettings } from './fake-settings.ts';

describe('the fake settings of the worker tests', () => {
  it('start from the product context defaults for every key', () => {
    const settings = createFakeSettings({ home: '/home/fake', project: '/project/fake' });
    expect(settings.contextValue).toEqual(defaultContextSettings());
  });

  it('give each fake its own copy of the defaults', () => {
    const first = createFakeSettings({ home: '/home/fake', project: '/project/fake' });
    const second = createFakeSettings({ home: '/home/fake', project: '/project/fake' });
    expect(first.contextValue).not.toBe(second.contextValue);
  });
});
