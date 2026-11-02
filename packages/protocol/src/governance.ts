export const GOVERNING_KINDS = ['constraint', 'preference', 'commitment', 'role', 'identity'] as const;

export type GoverningKind = (typeof GOVERNING_KINDS)[number];

export type GoverningFactView = {
  id: string;
  kind: GoverningKind;
  target: string;
  text: string;
  scope: { level: 'user' } | { level: 'project'; project: string; paths: string[] };
  validFrom: number;
  validUntil: number | null;
  retiredAt: number | null;
  supersedes: string[];
  enforcement: { behavior: 'deny' | 'ask'; rule: string } | null;
  source: { kind: 'command'; at: number } | { kind: 'proposal'; sessionId: string; runId: string; seq: number; callId: string };
};
