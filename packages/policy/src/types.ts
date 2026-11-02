import type { GoverningEnforcement, GoverningFactView, GoverningKind, MemoryScope, SideEffect, ToolKind } from '@momonga/protocol';

export type PolicyTool = { name: string; kind: ToolKind; sideEffect: SideEffect };

export type PermissionSubject =
  | { kind: 'path'; tool: string; paths: readonly string[]; access: 'read' | 'write' }
  | { kind: 'command'; tool: string; command: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'memory'; tool: string; scope: MemoryScope }
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
