import type { ProcessInspector } from '../../src/platform/inspector-types.ts';

export const callsWithoutSignal = (inspector: ProcessInspector): void => {
  // @ts-expect-error a probe without the signal of its caller does not compile
  void inspector.holdersOf('/m/marker');
  // @ts-expect-error a probe without the signal of its caller does not compile
  void inspector.startTimeOf(42);
  // @ts-expect-error a probe without the signal of its caller does not compile
  void inspector.groupsOf([42], []);
  // @ts-expect-error a probe without the signal of its caller does not compile
  void inspector.markerState('/m/marker');
};
