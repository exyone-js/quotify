import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { TEST_ADMIN_TOKEN } from './tests/test-token.ts';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // ADMIN_TOKEN 刻意不在 wrangler.toml 里提供默认值；
      // 测试通过 miniflare bindings 注入，避免「为了跑测试而把口令写进配置」。
      miniflare: { bindings: { ADMIN_TOKEN: TEST_ADMIN_TOKEN } },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
