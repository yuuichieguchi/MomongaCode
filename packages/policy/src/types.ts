import type { NetworkRequest } from '@momonga/foundation';
import type { GoverningEnforcement, GoverningFactView, GoverningKind, MemoryKind, MemoryScope, SideEffect, ToolKind } from '@momonga/protocol';

export type PolicyTool = { name: string; kind: ToolKind } & (
  | { sideEffect: 'read_only'; subjectKind?: PermissionSubject['kind'] }
  | { sideEffect: Exclude<SideEffect, 'read_only'>; subjectKind: PermissionSubject['kind'] }
);

export type PermissionSubject =
  | { kind: 'path'; tool: string; paths: readonly string[]; access: 'read' | 'write' }
  | { kind: 'command'; tool: string; command: string; network?: NetworkRequest }
  | { kind: 'mcp'; server: string; tool: string }
  | {
      kind: 'memory';
      tool: string;
      scope: MemoryScope;
      text: string;
      memoryKind: MemoryKind;
      paths: readonly string[];
      supersedes: readonly string[];
    }
  | { kind: 'history'; tool: string; project: string }
  | {
      kind: 'governance';
      tool: string;
      factKind: GoverningKind;
      target: string;
      text: string;
      scope: GoverningFactView['scope'];
      enforcement: GoverningEnforcement | null;
      supersedes: readonly string[];
    }
  | { kind: 'none'; tool: string };

export type DecisionKind = 'allow' | 'ask' | 'deny';
