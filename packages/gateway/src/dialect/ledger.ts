import type { SchemaNarrowing, WrapRecord } from '@momonga/protocol';
import type { RenderedSchema } from './render.ts';

export class RenderLedger {
  private readonly wrapRecords = new Map<string, WrapRecord>();
  private readonly narrowed = new Map<string, SchemaNarrowing>();

  record(rendered: RenderedSchema): void {
    for (const wrap of rendered.wraps) if (wrap.wrapped.length > 0) this.wrapRecords.set(wrap.tool, wrap);
    for (const narrowing of rendered.narrowings) this.narrowed.set(`${narrowing.tool}\u0000${narrowing.path}`, narrowing);
  }

  get wraps(): ReadonlyMap<string, WrapRecord> {
    return this.wrapRecords;
  }

  get narrowings(): readonly SchemaNarrowing[] {
    return [...this.narrowed.values()];
  }
}
