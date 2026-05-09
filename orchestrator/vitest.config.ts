import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // Test file patterns
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'tests/integration/**'],

    // ESM support
    globals: false,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },

    // Environment
    environment: 'node',

    // Timeouts
    testTimeout: 10000,
    hookTimeout: 10000,

    // Retry flaky tests
    retry: 1,

    // Reporters
    reporters: ['verbose'],

    // Isolation
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },

    // Global setup / teardown
    globalSetup: [],
  },

  resolve: {
    alias: {
      '@core': resolve(__dirname, './src/core'),
      '@graph': resolve(__dirname, './src/graph'),
      '@utils': resolve(__dirname, './src/utils'),
    },
  },
});
