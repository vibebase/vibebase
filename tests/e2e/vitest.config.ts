import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load environment variables from .env.test
  const env = loadEnv('test', process.cwd(), '');
  
  return {
    test: {
      env: {
        ...env,
        // Force load from .env.test
        VIBEBASE_API_URL: env.VIBEBASE_API_URL || 'http://localhost:8787',
        VIBEBASE_API_KEY: env.VIBEBASE_API_KEY || '',
        VIBEBASE_TEST_USER_TOKEN: env.VIBEBASE_TEST_USER_TOKEN || '',
        CLEANUP_BEFORE_TEST: env.CLEANUP_BEFORE_TEST || 'true',
      },
      environment: 'jsdom',
      globals: true,
      testTimeout: 60000,  // リアルタイムテスト用に延長
      hookTimeout: 60000,  // フックタイムアウトも延長
      setupFiles: ['./vitest.setup.ts'],
      sequence: {
        shuffle: false, // E2Eテストは順序に依存する場合があるため
        concurrent: false, // 並列実行を無効化してリソース競合を防ぐ
      },
      // ファイル間の並列実行を制限
      maxConcurrency: 1,
      // ワーカー数を制限
      pool: 'threads',
      poolOptions: {
        threads: {
          maxThreads: 1,
          minThreads: 1,
        },
      },
    },
  };
});