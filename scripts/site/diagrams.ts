const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const svg = (width: number, height: number, body: string): string =>
  `<figure class="diagram-frame" aria-hidden="true"><svg class="diagram" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" focusable="false">${body}</svg></figure>`;

const box = (x: number, y: number, w: number, h: number, stroke = 'var(--line-strong)', fill = 'var(--page-background)', accent?: string): string =>
  [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.25"/>`,
    accent === undefined ? '' : `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${accent}"/>`,
  ].join('');

const label = (x: number, y: number, text: string, options: { size?: number; weight?: number; fill?: string; mono?: boolean; anchor?: 'start' | 'middle' | 'end' } = {}): string => {
  const size = options.size ?? 13;
  const weight = options.weight ?? 600;
  const fill = options.fill ?? 'var(--page-text)';
  const font = options.mono === true ? FONT_MONO : FONT_SANS;
  const anchor = options.anchor ?? 'middle';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}">${text}</text>`;
};

const arrowDefs = (prefix: string): string =>
  `<defs><marker id="${prefix}-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="var(--notice)"/></marker><marker id="${prefix}-arr-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="var(--banner-membrane)"/></marker></defs>`;

const line = (prefix: string, x1: number, y1: number, x2: number, y2: number, accent = false): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${accent ? 'var(--banner-membrane)' : 'var(--notice)'}" stroke-width="1.4" marker-end="url(#${prefix}-${accent ? 'arr-accent' : 'arr'})"/>`;

const pathArrow = (prefix: string, d: string, stroke = 'var(--notice)', dashed = false, accent = false): string =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4"${dashed ? ' stroke-dasharray="4 4"' : ''} marker-end="url(#${prefix}-${accent ? 'arr-accent' : 'arr'})"/>`;

export const architectureDiagram = (): string => {
  const p = 'arch';
  return svg(
    860,
    370,
    [
      arrowDefs(p),
      box(250, 16, 360, 56, 'var(--banner-membrane)', 'var(--page-background)', 'var(--banner-membrane)'),
      label(430, 36, 'CLI  ·  Terminal UI  ·  ACP Server', { size: 14, weight: 700 }),
      label(430, 55, 'packages/cli', { size: 11.5, weight: 500, fill: 'var(--code)', mono: true }),

      line(p, 430, 72, 430, 104, true),

      box(250, 108, 360, 56, 'var(--banner-fur)', 'var(--page-background)', 'var(--banner-fur)'),
      label(430, 128, 'Daemon Supervisor', { size: 14, weight: 700 }),
      label(430, 147, 'packages/supervisor  ·  versioned generations', { size: 11.5, weight: 500, fill: 'var(--notice)', mono: true }),

      pathArrow(p, 'M 350 164 L 350 184 L 220 184 L 220 202', 'var(--banner-membrane)', false, true),
      pathArrow(p, 'M 510 164 L 510 184 L 640 184 L 640 202', 'var(--banner-membrane)', false, true),

      box(32, 206, 376, 72, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-membrane)'),
      label(220, 227, 'Runtime  (sessions & tool loop)', { size: 13.5, weight: 700 }),
      label(220, 246, 'packages/runtime', { size: 11.5, weight: 500, fill: 'var(--code)', mono: true }),
      label(220, 264, 'context · memory · policy · sandbox · tools · mcp', { size: 11, weight: 500, fill: 'var(--notice)', mono: true }),

      box(452, 206, 376, 72, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-fur)'),
      label(640, 227, 'Gateway  (routing, retries, probing)', { size: 13.5, weight: 700 }),
      label(640, 246, 'packages/gateway', { size: 11.5, weight: 500, fill: 'var(--code)', mono: true }),
      label(640, 264, 'Ollama · Anthropic · OpenAI · Responses · fm', { size: 11, weight: 500, fill: 'var(--notice)', mono: true }),

      line(p, 408, 242, 448, 242, true),

      line(p, 150, 278, 150, 304, false),
      line(p, 430, 278, 430, 304, false),
      line(p, 710, 278, 710, 304, false),

      box(32, 308, 248, 48, 'var(--line-subtle)', 'var(--page-background)'),
      label(156, 325, 'State Store', { size: 12.5, weight: 700 }),
      label(156, 343, 'packages/store  ·  ~/.momonga/state', { size: 10.5, weight: 500, fill: 'var(--notice)', mono: true }),

      box(306, 308, 248, 48, 'var(--line-subtle)', 'var(--page-background)'),
      label(430, 325, 'Verify & Eval', { size: 12.5, weight: 700 }),
      label(430, 343, 'Z3 policy · eval bench · TLA+ specs', { size: 10.5, weight: 500, fill: 'var(--notice)', mono: true }),

      box(580, 308, 248, 48, 'var(--line-subtle)', 'var(--page-background)'),
      label(704, 325, 'Observability & Config', { size: 12.5, weight: 700 }),
      label(704, 343, 'traces · cost · OTLP · layered config', { size: 10.5, weight: 500, fill: 'var(--notice)', mono: true }),
    ].join(''),
  );
};

export const memoryLoopDiagram = (): string => {
  const p = 'mem';
  return svg(
    860,
    180,
    [
      arrowDefs(p),
      box(20, 34, 178, 86, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-membrane)'),
      label(109, 60, '1. Recorded Events', { size: 12.5, weight: 700 }),
      label(109, 82, 'Verified runs propose', { size: 11, weight: 400, fill: 'var(--text-body)' }),
      label(109, 98, 'facts & procedures', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      line(p, 198, 77, 228, 77, true),

      box(232, 34, 184, 86, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-fur)'),
      label(324, 60, '2. Review & Evidence', { size: 12.5, weight: 700 }),
      label(324, 82, 'Accept / reject queue', { size: 11, weight: 400, fill: 'var(--text-body)' }),
      label(324, 98, 'SHA-256 stale check', { size: 11, weight: 500, fill: 'var(--code)', mono: true }),

      line(p, 416, 77, 446, 77, true),

      box(450, 34, 184, 86, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-membrane)'),
      label(542, 60, '3. Adaptive Budget', { size: 12.5, weight: 700 }),
      label(542, 82, 'Every 20 runs: 1/16–1/2', { size: 11, weight: 500, fill: 'var(--code)', mono: true }),
      label(542, 98, '<25% halve · >75% double', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      line(p, 634, 77, 664, 77, true),

      box(668, 34, 172, 86, 'var(--line-strong)', 'var(--page-background)', 'var(--success)'),
      label(754, 60, '4. Prompt Context', { size: 12.5, weight: 700 }),
      label(754, 82, 'Rules + memory +', { size: 11, weight: 400, fill: 'var(--text-body)' }),
      label(754, 98, 'searchable history', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      pathArrow(p, 'M 754 120 L 754 156 L 542 156 L 542 124', 'var(--notice)', true, false),
      label(648, 146, 'usage feedback', { size: 11, weight: 500, fill: 'var(--notice)', mono: true }),
    ].join(''),
  );
};

export const daemonHandoverDiagram = (): string => {
  const p = 'upd';
  return svg(
    860,
    182,
    [
      arrowDefs(p),
      box(20, 56, 200, 70, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-membrane)'),
      label(120, 82, 'momonga update', { size: 13, weight: 700, mono: true }),
      label(120, 104, 'Verify sig + SHA-256', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      pathArrow(p, 'M 220 76 L 266 76 L 266 48 L 296 48', 'var(--banner-membrane)', false, true),
      pathArrow(p, 'M 220 106 L 266 106 L 266 134 L 296 134', 'var(--notice)', false, false),

      box(300, 16, 268, 64, 'var(--success)', 'var(--page-background)', 'var(--success)'),
      label(434, 39, 'New-version daemon starts', { size: 13, weight: 700 }),
      label(434, 59, 'Serves all new requests immediately', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      line(p, 568, 48, 608, 48, true),

      box(612, 16, 228, 64, 'var(--line-subtle)', 'var(--page-background)'),
      label(726, 39, 'Active generation', { size: 12.5, weight: 700, fill: 'var(--success)' }),
      label(726, 59, 'Zero downtime', { size: 11, weight: 500, fill: 'var(--notice)', mono: true }),

      box(300, 102, 268, 64, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-fur)'),
      label(434, 125, 'Previous daemon (retiring)', { size: 13, weight: 700 }),
      label(434, 145, 'Finishes in-flight steps & jobs', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      line(p, 568, 134, 608, 134, false),

      box(612, 102, 228, 64, 'var(--line-subtle)', 'var(--page-background)'),
      label(726, 125, 'Exits cleanly on its own', { size: 12.5, weight: 700 }),
      label(726, 145, 'Old sessions prompt reopen', { size: 11, weight: 400, fill: 'var(--notice)' }),
    ].join(''),
  );
};

export const verificationLoopDiagram = (): string => {
  const p = 'ver';
  return svg(
    860,
    196,
    [
      arrowDefs(p),
      box(20, 32, 168, 68, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-membrane)'),
      label(104, 56, 'Model stops', { size: 13, weight: 700 }),
      label(104, 77, 'Claims task done', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      line(p, 188, 66, 224, 66, true),

      box(228, 32, 232, 68, 'var(--line-strong)', 'var(--page-background)', 'var(--banner-fur)'),
      label(344, 56, 'Runtime runs checks', { size: 13, weight: 700 }),
      label(344, 77, 'In sandbox (not model evidence)', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      pathArrow(p, 'M 460 52 L 548 52', 'var(--success)', false, false),
      label(504, 38, 'all pass', { size: 11, weight: 600, fill: 'var(--success)', mono: true }),

      box(552, 22, 288, 60, 'var(--success)', 'var(--page-background)', 'var(--success)'),
      label(696, 44, 'COMPLETED', { size: 13, weight: 700, fill: 'var(--success)', mono: true }),
      label(696, 63, 'Verified · eligible to propose memories', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      pathArrow(p, 'M 460 80 L 502 80 L 502 146 L 548 146', 'var(--error)', false, false),
      label(504, 164, 'no change', { size: 10.5, weight: 600, fill: 'var(--error)', mono: true }),

      box(552, 114, 288, 62, 'var(--line-strong)', 'var(--page-background)', 'var(--error)'),
      label(696, 137, 'STOPPED (conditions_unmet)', { size: 12.5, weight: 700, fill: 'var(--error)', mono: true }),
      label(696, 157, 'Names unmet checks · exits non-zero', { size: 11, weight: 400, fill: 'var(--text-body)' }),

      pathArrow(p, 'M 344 100 L 344 156 L 104 156 L 104 104', 'var(--banner-membrane)', true, true),
      label(224, 144, 'failed & workspace changed → retry', { size: 11, weight: 500, fill: 'var(--banner-membrane)', mono: true }),
    ].join(''),
  );
};
