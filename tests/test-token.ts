/**
 * 集成测试使用的管理 Token。
 *
 * `wrangler.toml` 里刻意不提供 `ADMIN_TOKEN` 默认值（忘记 `wrangler secret put`
 * 就等于管理接口公开），测试所需的 Token 由 `vitest.config.ts` 注入 miniflare。
 * 两边必须一致，因此把常量放在这里共用，避免漂移。
 */
export const TEST_ADMIN_TOKEN = 'test-admin-token';
