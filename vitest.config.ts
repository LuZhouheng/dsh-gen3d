import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 兼容两处测试目录：src/**/*.test.ts（含已收口为 vitest 的 legacy 旧测试）
    // 与独立 tests/。
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
