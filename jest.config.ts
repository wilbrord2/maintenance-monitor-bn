import { type Config } from 'jest';

const transform: Config['transform'] = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
};

const config: Config = {
  watchman: false,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    '!src/database/scripts/**',
    '!src/database/data-source.ts',
    '!src/database/migrations/**',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { statements: 90, branches: 80, functions: 90, lines: 90 },
  },
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform,
      roots: ['<rootDir>/src'],
      testMatch: ['**/*.spec.ts'],
      setupFiles: ['reflect-metadata'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform,
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.test.ts'],
      setupFiles: ['reflect-metadata', '<rootDir>/test/helpers/load-test-env.ts'],
      globalSetup: '<rootDir>/test/helpers/global-setup.ts',
      testTimeout: 30_000,
    },
  ],
};

export default config;
