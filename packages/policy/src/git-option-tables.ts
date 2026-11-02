export type GitOptionTable = { flags: readonly string[]; values: readonly string[]; optionalValues: readonly string[] };

export const GIT_OPTION_TABLES: Readonly<Record<string, GitOptionTable>> = {
  status: {
    flags: ['--ahead-behind', '--branch', '--long', '--no-ahead-behind', '--no-branch', '--no-column', '--no-ignore-submodules', '--no-ignored', '--no-long', '--no-null', '--no-porcelain', '--no-renames', '--no-short', '--no-show-stash', '--no-untracked-files', '--no-verbose', '--null', '--renames', '--short', '--show-stash', '--verbose', '-b', '-s', '-v', '-z'],
    values: [],
    optionalValues: ['--column', '--find-renames', '--ignore-submodules', '--ignored', '--porcelain', '--untracked-files', '-M', '-u'],
  },
  log: {
    flags: ['--abbrev-commit', '--all', '--all-match', '--alternate-refs', '--author-date-order', '--basic-regexp', '--binary', '--bisect', '--boundary', '--cc', '--check', '--cherry', '--cherry-mark', '--cherry-pick', '--children', '--clear-decorations', '--combined-all-paths', '--compact-summary', '--cumulative', '--date-order', '--dd', '--default-prefix', '--dense', '--do-walk', '--exclude-first-parent-only', '--ext-diff', '--extended-regexp', '--find-copies-harder', '--first-parent', '--fixed-strings', '--follow', '--full-diff', '--full-history', '--full-index', '--function-context', '--graph', '--histogram', '--ignore-all-space', '--ignore-blank-lines', '--ignore-cr-at-eol', '--ignore-missing', '--ignore-space-at-eol', '--ignore-space-change', '--indent-heuristic', '--invert-grep', '--irreversible-delete', '--ita-invisible-in-index', '--left-only', '--left-right', '--log-size', '--mailmap', '--maximal-only', '--merge', '--merges', '--minimal', '--name-only', '--name-status', '--no-abbrev', '--no-abbrev-commit', '--no-color', '--no-color-moved', '--no-color-moved-ws', '--no-decorate', '--no-decorate-refs', '--no-decorate-refs-exclude', '--no-diff-merges', '--no-expand-tabs', '--no-ext-diff', '--no-indent-heuristic', '--no-mailmap', '--no-max-parents', '--no-merges', '--no-min-parents', '--no-notes', '--no-patch', '--no-prefix', '--no-quiet', '--no-relative', '--no-rename-empty', '--no-renames', '--no-source', '--no-standard-notes', '--no-textconv', '--no-use-mailmap', '--not', '--numstat', '--oneline', '--parents', '--patch', '--patch-with-raw', '--patch-with-stat', '--patience', '--perl-regexp', '--pickaxe-all', '--pickaxe-regex', '--quiet', '--raw', '--reflog', '--regexp-ignore-case', '--relative-date', '--remerge-diff', '--remove-empty', '--rename-empty', '--reverse', '--right-only', '--shortstat', '--show-notes-by-default', '--show-pulls', '--show-signature', '--simplify-by-decoration', '--simplify-merges', '--single-worktree', '--source', '--sparse', '--standard-notes', '--stdin', '--summary', '--text', '--textconv', '--topo-order', '--use-mailmap', '--walk-reflogs', '-D', '-E', '-F', '-P', '-R', '-W', '-a', '-b', '-c', '-g', '-i', '-m', '-p', '-q', '-s', '-t', '-u', '-w', '-z'],
    values: ['--after', '--anchored', '--author', '--before', '--color-moved-ws', '--committer', '--date', '--decorate-refs', '--decorate-refs-exclude', '--diff-algorithm', '--diff-filter', '--diff-merges', '--dst-prefix', '--encoding', '--exclude', '--exclude-hidden', '--find-object', '--glob', '--grep', '--grep-reflog', '--ignore-matching-lines', '--inter-hunk-context', '--line-prefix', '--max-count', '--max-depth', '--output', '--output-indicator-context', '--output-indicator-new', '--output-indicator-old', '--rotate-to', '--since', '--since-as-filter', '--skip', '--skip-to', '--src-prefix', '--until', '--word-diff-regex', '--ws-error-highlight', '-G', '-I', '-L', '-O', '-S', '-l', '-n'],
    optionalValues: ['--abbrev', '--ancestry-path', '--branches', '--break-rewrites', '--color', '--color-moved', '--color-words', '--decorate', '--dirstat', '--dirstat-by-file', '--expand-tabs', '--find-copies', '--find-renames', '--format', '--ignore-submodules', '--max-parents', '--min-parents', '--no-walk', '--notes', '--pretty', '--relative', '--remotes', '--show-linear-break', '--show-notes', '--stat', '--submodule', '--tags', '--unified', '--word-diff', '-B', '-C', '-M', '-U', '-X'],
  },
  diff: {
    flags: ['--base', '--binary', '--cached', '--cc', '--check', '--compact-summary', '--cumulative', '--default-prefix', '--exit-code', '--ext-diff', '--find-copies-harder', '--follow', '--full-index', '--function-context', '--histogram', '--ignore-all-space', '--ignore-blank-lines', '--ignore-cr-at-eol', '--ignore-space-at-eol', '--ignore-space-change', '--indent-heuristic', '--irreversible-delete', '--ita-invisible-in-index', '--ita-visible-in-index', '--merge-base', '--minimal', '--name-only', '--name-status', '--no-abbrev', '--no-color', '--no-color-moved', '--no-color-moved-ws', '--no-compact-summary', '--no-exit-code', '--no-ext-diff', '--no-find-copies-harder', '--no-follow', '--no-full-index', '--no-function-context', '--no-ignore-matching-lines', '--no-indent-heuristic', '--no-index', '--no-patch', '--no-prefix', '--no-quiet', '--no-relative', '--no-rename-empty', '--no-renames', '--no-text', '--no-textconv', '--numstat', '--ours', '--patch', '--patch-with-raw', '--patch-with-stat', '--patience', '--pickaxe-all', '--pickaxe-regex', '--quiet', '--raw', '--rename-empty', '--shortstat', '--staged', '--summary', '--text', '--textconv', '--theirs', '-0', '-1', '-2', '-3', '-D', '-R', '-W', '-a', '-b', '-p', '-s', '-u', '-w', '-z'],
    values: ['--anchored', '--color-moved-ws', '--diff-algorithm', '--diff-filter', '--dst-prefix', '--find-object', '--ignore-matching-lines', '--inter-hunk-context', '--line-prefix', '--max-depth', '--output', '--output-indicator-context', '--output-indicator-new', '--output-indicator-old', '--rotate-to', '--skip-to', '--src-prefix', '--stat-count', '--stat-graph-width', '--stat-name-width', '--stat-width', '--word-diff-regex', '--ws-error-highlight', '-G', '-I', '-O', '-S', '-l'],
    optionalValues: ['--abbrev', '--break-rewrites', '--color', '--color-moved', '--color-words', '--dirstat', '--dirstat-by-file', '--find-copies', '--find-renames', '--ignore-submodules', '--relative', '--stat', '--submodule', '--unified', '--word-diff', '-B', '-C', '-M', '-U', '-X'],
  },
  show: {
    flags: ['--abbrev-commit', '--binary', '--cc', '--check', '--clear-decorations', '--combined-all-paths', '--compact-summary', '--cumulative', '--dd', '--default-prefix', '--ext-diff', '--find-copies-harder', '--full-index', '--function-context', '--histogram', '--ignore-all-space', '--ignore-blank-lines', '--ignore-cr-at-eol', '--ignore-space-at-eol', '--ignore-space-change', '--indent-heuristic', '--irreversible-delete', '--ita-invisible-in-index', '--mailmap', '--minimal', '--name-only', '--name-status', '--no-abbrev', '--no-abbrev-commit', '--no-color', '--no-color-moved', '--no-color-moved-ws', '--no-decorate', '--no-decorate-refs', '--no-decorate-refs-exclude', '--no-diff-merges', '--no-expand-tabs', '--no-ext-diff', '--no-indent-heuristic', '--no-mailmap', '--no-notes', '--no-patch', '--no-prefix', '--no-quiet', '--no-relative', '--no-rename-empty', '--no-renames', '--no-source', '--no-standard-notes', '--no-textconv', '--no-use-mailmap', '--numstat', '--oneline', '--patch', '--patch-with-raw', '--patch-with-stat', '--patience', '--pickaxe-all', '--pickaxe-regex', '--quiet', '--raw', '--remerge-diff', '--rename-empty', '--shortstat', '--show-notes-by-default', '--show-signature', '--source', '--standard-notes', '--summary', '--text', '--textconv', '--use-mailmap', '-D', '-R', '-W', '-a', '-b', '-c', '-m', '-p', '-q', '-s', '-t', '-u', '-w', '-z'],
    values: ['--anchored', '--color-moved-ws', '--decorate-refs', '--decorate-refs-exclude', '--diff-algorithm', '--diff-filter', '--diff-merges', '--dst-prefix', '--encoding', '--find-object', '--ignore-matching-lines', '--inter-hunk-context', '--line-prefix', '--max-depth', '--output', '--output-indicator-context', '--output-indicator-new', '--output-indicator-old', '--rotate-to', '--skip-to', '--src-prefix', '--word-diff-regex', '--ws-error-highlight', '-G', '-I', '-L', '-O', '-S', '-l'],
    optionalValues: ['--abbrev', '--break-rewrites', '--color', '--color-moved', '--color-words', '--decorate', '--dirstat', '--dirstat-by-file', '--expand-tabs', '--find-copies', '--find-renames', '--format', '--ignore-submodules', '--notes', '--pretty', '--relative', '--show-notes', '--stat', '--submodule', '--unified', '--word-diff', '-B', '-C', '-M', '-U', '-X'],
  },
  blame: {
    flags: ['--color-by-age', '--color-lines', '--first-parent', '--incremental', '--line-porcelain', '--no-abbrev', '--no-color-by-age', '--no-color-lines', '--no-contents', '--no-ignore-rev', '--no-ignore-revs-file', '--no-incremental', '--no-line-porcelain', '--no-porcelain', '--no-progress', '--no-root', '--no-score-debug', '--no-show-email', '--no-show-name', '--no-show-number', '--no-show-stats', '--porcelain', '--progress', '--root', '--score-debug', '--show-email', '--show-name', '--show-number', '--show-stats', '-b', '-c', '-e', '-f', '-h', '-l', '-n', '-p', '-s', '-t', '-w'],
    values: ['--contents', '--date', '--diff-algorithm', '--encoding', '--ignore-rev', '--ignore-revs-file', '-L', '-S'],
    optionalValues: ['--abbrev', '--reverse', '-C', '-M'],
  },
  'ls-files': {
    flags: ['--cached', '--debug', '--deduplicate', '--deleted', '--directory', '--empty-directory', '--eol', '--error-unmatch', '--exclude-standard', '--full-name', '--ignored', '--killed', '--modified', '--no-abbrev', '--no-cached', '--no-debug', '--no-deduplicate', '--no-deleted', '--no-directory', '--no-empty-directory', '--no-eol', '--no-error-unmatch', '--no-exclude-per-directory', '--no-ignored', '--no-killed', '--no-modified', '--no-others', '--no-recurse-submodules', '--no-resolve-undo', '--no-sparse', '--no-stage', '--no-unmerged', '--no-with-tree', '--others', '--recurse-submodules', '--resolve-undo', '--sparse', '--stage', '--unmerged', '-c', '-d', '-f', '-i', '-k', '-m', '-o', '-s', '-t', '-u', '-v', '-z'],
    values: ['--exclude', '--exclude-from', '--exclude-per-directory', '--format', '--with-tree', '-X', '-x'],
    optionalValues: ['--abbrev'],
  },
  'ls-tree': {
    flags: ['--full-name', '--full-tree', '--long', '--name-only', '--name-status', '--no-abbrev', '--no-full-name', '--no-full-tree', '--object-only', '-d', '-l', '-r', '-t', '-z'],
    values: ['--format'],
    optionalValues: ['--abbrev'],
  },
  'rev-parse': {
    flags: ['--absolute-git-dir', '--all', '--flags', '--git-common-dir', '--git-dir', '--is-bare-repository', '--is-inside-git-dir', '--is-inside-work-tree', '--is-shallow-repository', '--keep-dashdash', '--local-env-vars', '--no-flags', '--no-revs', '--not', '--parseopt', '--quiet', '--revs-only', '--shared-index-path', '--show-cdup', '--show-prefix', '--show-ref-format', '--show-superproject-working-tree', '--show-toplevel', '--sq', '--sq-quote', '--stop-at-non-option', '--stuck-long', '--symbolic', '--symbolic-full-name', '--verify', '-q'],
    values: ['--default', '--git-path', '--prefix', '--resolve-git-dir'],
    optionalValues: ['--abbrev-ref', '--after', '--before', '--branches', '--disambiguate', '--exclude', '--exclude-hidden', '--glob', '--output-object-format', '--path-format', '--remotes', '--short', '--show-object-format', '--since', '--tags', '--until'],
  },
  'rev-list': {
    flags: ['--abbrev-commit', '--all', '--all-match', '--alternate-refs', '--author-date-order', '--basic-regexp', '--bisect', '--bisect-all', '--bisect-vars', '--boundary', '--cherry', '--cherry-mark', '--cherry-pick', '--children', '--commit-header', '--count', '--date-order', '--dense', '--do-walk', '--exclude-first-parent-only', '--exclude-promisor-objects', '--extended-regexp', '--filter-print-omitted', '--filter-provided-objects', '--first-parent', '--fixed-strings', '--full-history', '--graph', '--header', '--ignore-missing', '--in-commit-order', '--indexed-objects', '--invert-grep', '--left-only', '--left-right', '--maximal-only', '--merge', '--merges', '--no-abbrev-commit', '--no-commit-header', '--no-expand-tabs', '--no-filter', '--no-max-parents', '--no-merges', '--no-min-parents', '--no-object-names', '--not', '--object-names', '--objects', '--objects-edge', '--objects-edge-aggressive', '--oneline', '--parents', '--perl-regexp', '--quiet', '--reflog', '--regexp-ignore-case', '--relative-date', '--remove-empty', '--reverse', '--right-only', '--show-pulls', '--show-signature', '--simplify-by-decoration', '--simplify-merges', '--single-worktree', '--sparse', '--stdin', '--timestamp', '--topo-order', '--unpacked', '--use-bitmap-index', '--walk-reflogs', '-E', '-F', '-P', '-g', '-i', '-z'],
    values: ['--after', '--author', '--before', '--committer', '--date', '--encoding', '--exclude', '--exclude-hidden', '--glob', '--grep', '--grep-reflog', '--max-age', '--max-count', '--min-age', '--since', '--since-as-filter', '--skip', '--until', '-n'],
    optionalValues: ['--abbrev', '--ancestry-path', '--branches', '--disk-usage', '--expand-tabs', '--filter', '--format', '--max-parents', '--min-parents', '--missing', '--no-walk', '--pretty', '--progress', '--remotes', '--show-linear-break', '--tags'],
  },
  describe: {
    flags: ['--all', '--always', '--contains', '--debug', '--exact-match', '--first-parent', '--long', '--no-abbrev', '--no-all', '--no-always', '--no-broken', '--no-candidates', '--no-contains', '--no-debug', '--no-dirty', '--no-exact-match', '--no-exclude', '--no-first-parent', '--no-long', '--no-match', '--no-tags', '--tags'],
    values: ['--candidates', '--exclude', '--match'],
    optionalValues: ['--abbrev', '--broken', '--dirty'],
  },
  shortlog: {
    flags: ['--all', '--all-match', '--alternate-refs', '--basic-regexp', '--bisect', '--boundary', '--cherry', '--cherry-mark', '--cherry-pick', '--committer', '--dense', '--email', '--exclude-first-parent-only', '--extended-regexp', '--first-parent', '--fixed-strings', '--full-history', '--ignore-missing', '--invert-grep', '--left-only', '--maximal-only', '--merge', '--merges', '--no-committer', '--no-email', '--no-group', '--no-max-parents', '--no-merges', '--no-min-parents', '--no-numbered', '--no-summary', '--not', '--numbered', '--perl-regexp', '--reflog', '--regexp-ignore-case', '--remove-empty', '--right-only', '--show-pulls', '--simplify-by-decoration', '--simplify-merges', '--single-worktree', '--sparse', '--stdin', '--summary', '--walk-reflogs', '-E', '-F', '-P', '-c', '-e', '-g', '-i', '-n', '-s'],
    values: ['--after', '--author', '--before', '--date', '--exclude', '--exclude-hidden', '--glob', '--grep', '--grep-reflog', '--group', '--max-count', '--since', '--since-as-filter', '--skip', '--until'],
    optionalValues: ['--ancestry-path', '--branches', '--format', '--max-parents', '--min-parents', '--remotes', '--tags', '-w'],
  },
  grep: {
    flags: ['--all-match', '--and', '--basic-regexp', '--break', '--cached', '--column', '--count', '--exclude-standard', '--ext-grep', '--extended-regexp', '--files-with-matches', '--files-without-match', '--fixed-strings', '--full-name', '--function-context', '--heading', '--ignore-case', '--index', '--invert-match', '--line-number', '--name-only', '--no-all-match', '--no-basic-regexp', '--no-break', '--no-cached', '--no-color', '--no-column', '--no-context', '--no-count', '--no-exclude-standard', '--no-ext-grep', '--no-extended-regexp', '--no-files-with-matches', '--no-files-without-match', '--no-fixed-strings', '--no-full-name', '--no-function-context', '--no-heading', '--no-ignore-case', '--no-index', '--no-invert-match', '--no-line-number', '--no-max-count', '--no-name-only', '--no-null', '--no-only-matching', '--no-open-files-in-pager', '--no-perl-regexp', '--no-quiet', '--no-recurse-submodules', '--no-recursive', '--no-show-function', '--no-text', '--no-textconv', '--no-threads', '--no-untracked', '--no-word-regexp', '--not', '--null', '--only-matching', '--or', '--perl-regexp', '--quiet', '--recurse-submodules', '--recursive', '--show-function', '--text', '--textconv', '--untracked', '--word-regexp', '-E', '-F', '-G', '-H', '-I', '-L', '-P', '-W', '-a', '-c', '-h', '-i', '-l', '-n', '-o', '-p', '-q', '-r', '-v', '-w', '-z'],
    values: ['--after-context', '--before-context', '--context', '--max-count', '--max-depth', '--threads', '-A', '-B', '-C', '-e', '-f', '-m'],
    optionalValues: ['--color', '--open-files-in-pager', '-O'],
  },
  'cat-file': {
    flags: ['--batch-all-objects', '--buffer', '--filters', '--follow-symlinks', '--mailmap', '--no-buffer', '--no-filter', '--no-follow-symlinks', '--no-mailmap', '--no-path', '--no-unordered', '--no-use-mailmap', '--textconv', '--unordered', '--use-mailmap', '-Z', '-e', '-p', '-s', '-t', '-z'],
    values: ['--filter', '--path'],
    optionalValues: ['--batch', '--batch-check', '--batch-command'],
  },
  'show-ref': {
    flags: ['--branches', '--dereference', '--exists', '--head', '--heads', '--no-abbrev', '--no-branches', '--no-dereference', '--no-exists', '--no-hash', '--no-head', '--no-quiet', '--no-tags', '--no-verify', '--quiet', '--tags', '--verify', '-d', '-q'],
    values: [],
    optionalValues: ['--abbrev', '--exclude-existing', '--hash', '-s'],
  },
  'name-rev': {
    flags: ['--all', '--always', '--annotate-stdin', '--name-only', '--no-all', '--no-always', '--no-annotate-stdin', '--no-exclude', '--no-name-only', '--no-refs', '--no-tags', '--no-undefined', '--tags', '--undefined'],
    values: ['--exclude', '--refs'],
    optionalValues: [],
  },
  'merge-base': {
    flags: ['--all', '--fork-point', '--independent', '--is-ancestor', '--no-all', '--octopus', '-a'],
    values: [],
    optionalValues: [],
  },
  'for-each-ref': {
    flags: ['--ignore-case', '--include-root-refs', '--no-color', '--no-count', '--no-exclude', '--no-format', '--no-ignore-case', '--no-include-root-refs', '--no-omit-empty', '--no-perl', '--no-points-at', '--no-python', '--no-shell', '--no-sort', '--no-start-after', '--no-stdin', '--no-tcl', '--omit-empty', '--perl', '--python', '--shell', '--stdin', '--tcl', '-p', '-s'],
    values: ['--contains', '--count', '--exclude', '--format', '--merged', '--no-contains', '--no-merged', '--points-at', '--sort', '--start-after'],
    optionalValues: ['--color'],
  },
  'count-objects': {
    flags: ['--human-readable', '--no-human-readable', '--no-verbose', '--verbose', '-H', '-v'],
    values: [],
    optionalValues: [],
  },
  'check-ignore': {
    flags: ['--index', '--no-index', '--no-non-matching', '--no-quiet', '--no-stdin', '--no-verbose', '--non-matching', '--quiet', '--stdin', '--verbose', '-n', '-q', '-v', '-z'],
    values: [],
    optionalValues: [],
  },
  reset: {
    flags: ['--auto-advance', '--hard', '--intent-to-add', '--keep', '--merge', '--mixed', '--no-auto-advance', '--no-intent-to-add', '--no-patch', '--no-pathspec-file-nul', '--no-pathspec-from-file', '--no-quiet', '--no-recurse-submodules', '--no-refresh', '--patch', '--pathspec-file-nul', '--quiet', '--refresh', '--soft', '-N', '-p', '-q'],
    values: ['--inter-hunk-context', '--pathspec-from-file', '--unified', '-U'],
    optionalValues: ['--recurse-submodules'],
  },
  clean: {
    flags: ['--dry-run', '--force', '--interactive', '--no-dry-run', '--no-force', '--no-interactive', '--no-quiet', '--quiet', '-X', '-d', '-f', '-i', '-n', '-q', '-x'],
    values: ['--exclude', '-e'],
    optionalValues: [],
  },
  checkout: {
    flags: ['--auto-advance', '--detach', '--force', '--guess', '--ignore-other-worktrees', '--ignore-skip-worktree-bits', '--merge', '--no-auto-advance', '--no-conflict', '--no-detach', '--no-force', '--no-guess', '--no-ignore-other-worktrees', '--no-ignore-skip-worktree-bits', '--no-merge', '--no-orphan', '--no-overlay', '--no-overwrite-ignore', '--no-patch', '--no-pathspec-file-nul', '--no-pathspec-from-file', '--no-progress', '--no-quiet', '--no-recurse-submodules', '--no-track', '--ours', '--overlay', '--overwrite-ignore', '--patch', '--pathspec-file-nul', '--progress', '--quiet', '--theirs', '-2', '-3', '-d', '-f', '-l', '-m', '-p', '-q'],
    values: ['--conflict', '--inter-hunk-context', '--orphan', '--pathspec-from-file', '--unified', '-B', '-U', '-b'],
    optionalValues: ['--recurse-submodules', '--track', '-t'],
  },
  switch: {
    flags: ['--detach', '--discard-changes', '--force', '--guess', '--ignore-other-worktrees', '--merge', '--no-conflict', '--no-create', '--no-detach', '--no-discard-changes', '--no-force', '--no-force-create', '--no-guess', '--no-ignore-other-worktrees', '--no-merge', '--no-orphan', '--no-overwrite-ignore', '--no-progress', '--no-quiet', '--no-recurse-submodules', '--no-track', '--overwrite-ignore', '--progress', '--quiet', '-d', '-f', '-m', '-q'],
    values: ['--conflict', '--create', '--force-create', '--orphan', '-C', '-c'],
    optionalValues: ['--recurse-submodules', '--track', '-t'],
  },
  restore: {
    flags: ['--ignore-skip-worktree-bits', '--ignore-unmerged', '--merge', '--no-conflict', '--no-ignore-skip-worktree-bits', '--no-ignore-unmerged', '--no-merge', '--no-overlay', '--no-patch', '--no-pathspec-file-nul', '--no-pathspec-from-file', '--no-progress', '--no-quiet', '--no-recurse-submodules', '--no-source', '--no-staged', '--no-worktree', '--ours', '--overlay', '--patch', '--pathspec-file-nul', '--progress', '--quiet', '--staged', '--theirs', '--worktree', '-2', '-3', '-S', '-W', '-m', '-p', '-q'],
    values: ['--conflict', '--inter-hunk-context', '--pathspec-from-file', '--source', '--unified', '-U', '-s'],
    optionalValues: ['--recurse-submodules'],
  },
};
