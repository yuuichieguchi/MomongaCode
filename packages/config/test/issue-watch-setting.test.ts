import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const MANDATES = { mandates: { triage: { ask: ['Bash'], steps: 20 } } };

const userLoad = (tree: ReturnType<typeof makeTree>) => loadUserSettings({ home: tree.home, signal: new AbortController().signal });

describe('issues.watch: the issues the watch takes, declared in the user settings (tools DECISION-1)', () => {
  it('a valid entry loads with its filter and its mandate', async () => {
    const tree = makeTree();
    const watch = [{ repository: 'acme/widgets', labels: ['momonga'], authorAssociation: ['OWNER', 'MEMBER'], mandate: 'triage' }];
    writeJson(userSettingsPath(tree), { ...MANDATES, issues: { watch } });
    const result = await userLoad(tree);
    expect(result.warnings).toEqual([]);
    expect(result.settings.issues).toEqual({ watch });
  });

  it('a mandate name that is not declared is refused naming the key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { ...MANDATES, issues: { watch: [{ repository: 'acme/widgets', labels: ['momonga'], mandate: 'nowhere' }] } });
    await expect(userLoad(tree)).rejects.toThrow(`${userSettingsPath(tree)}: invalid settings at /issues/watch/0/mandate: "nowhere" is not a mandate declared under mandates; the mandates are triage`);
  });

  it('a repository that is not owner/name is refused at its pointer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { ...MANDATES, issues: { watch: [{ repository: 'widgets', labels: ['momonga'], mandate: 'triage' }] } });
    await expect(userLoad(tree)).rejects.toThrow('invalid settings at /issues/watch/0/repository');
  });

  it('an entry without labels or authorAssociation loads with the warning that it takes nothing', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { ...MANDATES, issues: { watch: [{ repository: 'acme/widgets', mandate: 'triage' }] } });
    const result = await userLoad(tree);
    expect(result.settings.issues?.watch).toHaveLength(1);
    expect(result.warnings).toEqual([`${userSettingsPath(tree)}: issues.watch[0] for acme/widgets has no labels and no authorAssociation, so it takes no issue; add a filter`]);
  });

  it('a project entry is discarded with a warning', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), MANDATES);
    writeJson(projectSettingsPath(tree), { issues: { watch: [{ repository: 'acme/widgets', labels: ['momonga'], mandate: 'triage' }] } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.issues).toBeUndefined();
    expect(result.warnings).toContain(`${projectSettingsPath(tree)}: issues is only honored in user settings; discarded`);
  });
});
