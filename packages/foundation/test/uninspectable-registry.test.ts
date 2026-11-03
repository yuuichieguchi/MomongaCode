import { describe, expect, it } from 'vitest';
import { createUninspectableRegistry, reportUninspectableOnce } from '@momonga/foundation';

const agent = { pid: 5150, command: 'ssh-agent', startTicks: '10' };

const registryWith = (alive: Set<number>) => createUninspectableRegistry({ isAlive: (pid) => alive.has(pid) });

describe('the uninspectable registry', () => {
  it('names a process once per reporting context, so each marker warns for itself', () => {
    const registry = registryWith(new Set([agent.pid]));
    expect(registry.firstNaming('tool marker /a', agent)).toBe(true);
    expect(registry.firstNaming('tool marker /a', agent)).toBe(false);
    expect(registry.firstNaming('mcp marker /b', agent)).toBe(true);
    expect(registry.firstNaming('mcp marker /b', agent)).toBe(false);
  });

  it('warns through reportUninspectableOnce once per context for the same process', () => {
    const registry = registryWith(new Set([agent.pid]));
    const warnings: string[] = [];
    const onWarning = (message: string): void => void warnings.push(message);
    reportUninspectableOnce(onWarning, 'tool marker /a', registry)(agent);
    reportUninspectableOnce(onWarning, 'tool marker /a', registry)(agent);
    reportUninspectableOnce(onWarning, 'mcp marker /b', registry)(agent);
    expect(warnings).toEqual([
      'tool marker /a: process 5150 (ssh-agent) could not be inspected, so it was left alone',
      'mcp marker /b: process 5150 (ssh-agent) could not be inspected, so it was left alone',
    ]);
  });

  it('drops the entry of a process that is gone when the registry is consulted', () => {
    const alive = new Set([agent.pid, 6000]);
    const registry = registryWith(alive);
    registry.firstNaming('tool marker /a', agent);
    registry.firstNaming('tool marker /a', { pid: 6000, command: 'sshd', startTicks: '1' });
    expect(registry.size()).toBe(2);
    alive.delete(agent.pid);
    expect(registry.firstNaming('tool marker /c', { pid: 6000, command: 'sshd', startTicks: '1' })).toBe(true);
    expect(registry.size()).toBe(2);
    alive.add(agent.pid);
    expect(registry.firstNaming('tool marker /a', agent)).toBe(true);
  });

  it('drops the stale entry of a pid that came back with another start tick', () => {
    const registry = registryWith(new Set([agent.pid]));
    registry.firstNaming('tool marker /a', agent);
    expect(registry.firstNaming('tool marker /a', { ...agent, startTicks: '11' })).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.firstNaming('tool marker /a', agent)).toBe(true);
  });

  it('drops the stale entry of a pid that came back with another start tick under another context', () => {
    const registry = registryWith(new Set([agent.pid]));
    registry.firstNaming('tool marker /a', agent);
    expect(registry.firstNaming('mcp marker /b', { ...agent, startTicks: '11' })).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.firstNaming('tool marker /a', agent)).toBe(true);
  });

  it('stays bounded by the processes that are still there', () => {
    const alive = new Set<number>();
    const registry = registryWith(alive);
    for (let pid = 100; pid < 200; pid += 1) {
      alive.add(pid);
      registry.firstNaming('tool marker /a', { pid, command: 'sshd', startTicks: '1' });
      alive.delete(pid - 1);
    }
    expect(registry.size()).toBeLessThanOrEqual(2);
  });
});
