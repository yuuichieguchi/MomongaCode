import { vi } from 'vitest';
import { startupCases } from './tui-startup-cases.tsx';

vi.hoisted(() => {
  delete process.env['FORCE_COLOR'];
});

startupCases('cleared');
