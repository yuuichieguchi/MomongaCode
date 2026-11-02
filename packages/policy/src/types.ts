import type { MemoryScope, ToolKind } from '@momonga/protocol';

export type SideEffect = 'read_only' | 'write' | 'exec';

export type PolicyTool = { name: string; kind: ToolKind; sideEffect: SideEffect };

export type PermissionSubject =
  | { kind: 'path'; tool: string; paths: readonly string[]; access: 'read' | 'write' }
  | { kind: 'command'; tool: string; command: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'memory'; tool: string; scope: MemoryScope }
  | { kind: 'none'; tool: string };

export type DecisionKind = 'allow' | 'ask' | 'deny';
