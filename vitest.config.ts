import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git worktrees under .claude/ carry their own copy of tests/ and src/. Without this they are
    // collected too, so the suite reports green partly from whatever code that worktree is pinned
    // to — including test files deleted on this branch.
    exclude: [...configDefaults.exclude, '.claude/**', 'web/**'],
  },
});
