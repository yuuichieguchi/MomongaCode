const HEARTBEAT_DIVISOR = 3;

export const heartbeatMsFor = (leaseMs: number): number => leaseMs / HEARTBEAT_DIVISOR;
