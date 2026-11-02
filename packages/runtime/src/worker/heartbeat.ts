const DEFAULT_HEARTBEAT_DIVISOR = 3;

export const heartbeatMsFor = (leaseMs: number): number => leaseMs / DEFAULT_HEARTBEAT_DIVISOR;
