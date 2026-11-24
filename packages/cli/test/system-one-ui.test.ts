import { describe, expect, it } from 'vitest';
import { modelFieldRows, serverFieldRows } from '../src/tui/models/fields.ts';
import { classifierOptionOf, modelOptionOf, selectableClassifierOf, selectableModelOf } from '../src/acp/models.ts';
import { describeClassification } from '../src/policy-messages.ts';
import type { ModelViews } from '@momonga/protocol';

describe('system-one CLI/TUI/ACP surfaces', () => {
  it('shows exact server and model edit fields for system-one (J29-A, J30-A, J31-A, J33-A, T4)', () => {
    const conn = {
      adapter: 'system-one',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'typesafe/jev-1.14', capabilities: { contextWindow: 262_144 } }],
    };
    expect(serverFieldRows(conn).map((r) => r.label)).toEqual([
      'Address',
      'Key',
      'Billing',
      'Concurrent requests',
      'Wait for a free slot',
    ]);
    expect(modelFieldRows(conn).map((r) => r.label)).toEqual([
      'Concurrent requests',
      'Wait for a free slot',
      'Context window',
    ]);
  });

  it('excludes choice models from ACP session model picker and includes them in ACP classifier picker (J11-3A, J19-A)', () => {
    const views: ModelViews = [
      { canon: 'openai/gpt-5', provider: 'openai', ownName: 'gpt-5', naming: 'account', outputKind: 'text' },
      { canon: 'openrouter/typesafe/jev-1.14', provider: 'openrouter', ownName: 'typesafe/jev-1.14', naming: 'account', outputKind: 'choice' },
    ];
    const modelOpt = modelOptionOf(views, 'openai/gpt-5');
    expect(modelOpt.type).toBe('select');
    if (modelOpt.type === 'select') {
      expect(modelOpt.options.map((o) => ('value' in o ? o.value : ''))).toEqual(['openai/gpt-5']);
    }
    expect(() => selectableModelOf(views, { configId: 'model', value: 'typesafe/jev-1.14' })).toThrow(
      'typesafe/jev-1.14 only judges approvals; it cannot be the model for a session.',
    );

    const clsOpt = classifierOptionOf(views, 'openrouter/typesafe/jev-1.14');
    expect(clsOpt.type).toBe('select');
    if (clsOpt.type === 'select') {
      expect(clsOpt.options.map((o) => ('value' in o ? o.value : ''))).toContain('openrouter/typesafe/jev-1.14');
    }
    expect(selectableClassifierOf(views, undefined, { configId: 'classifier', value: 'typesafe/jev-1.14' })).toBe('openrouter/typesafe/jev-1.14');
  });

  it('formats choice verdict without rationale (J2-A)', () => {
    expect(
      describeClassification(
        {
          id: 1,
          runId: 'r1',
          sessionId: 's1',
          step: 1,
          createdAt: 0,
          type: 'tool.permission.classified',
          callId: 'c1',
          subjectDigest: 'd1',
          seq: 1,
          outcome: 'allow',
          model: 'typesafe/jev-1.14',
          verdict: 'safe',
          confidence: 'high',
        },
        'Bash',
      ),
    ).toBe('auto mode allowed Bash; classifier typesafe/jev-1.14 judged Bash safe with high confidence');
  });
});
