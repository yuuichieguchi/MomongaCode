import type { ProcessInspector } from '../../src/platform/inspector-types.ts';

export const callsWithoutSignal = (inspector: ProcessInspector): void => {
  // @ts-expect-error
  void inspector.holdersOf('/m/marker');
  // @ts-expect-error
  void inspector.startTimeOf(42);
  // @ts-expect-error
  void inspector.groupsOf([42], []);
  // @ts-expect-error
  void inspector.markerState('/m/marker');
};
