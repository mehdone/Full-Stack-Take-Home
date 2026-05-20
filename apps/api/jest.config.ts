export default {
  displayName: "@highwood/api",
  testEnvironment: "node",
  rootDir: "./",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  moduleFileExtensions: ["js", "json", "ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  preset: "ts-jest",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          target: "ES2022",
          esModuleInterop: true,
          skipLibCheck: true,
          baseUrl: ".",
          paths: {
            "@highwood/db": ["../../packages/db/src/index.ts"],
            "@highwood/db/*": ["../../packages/db/src/*"],
            "@highwood/contracts": ["../../packages/contracts/src/index.ts"],
            "@highwood/contracts/*": ["../../packages/contracts/src/*"],
          },
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@highwood/(.+)$": "<rootDir>/../../packages/$1/src/index.ts",
    "^@highwood/(.+)/(.+)$": "<rootDir>/../../packages/$1/src/$2.ts",
  },
  testTimeout: 30000,
  maxWorkers: 1,
  globalSetup: "<rootDir>/test/setup.ts",
  globalTeardown: "<rootDir>/test/teardown.ts",
  setupFilesAfterEnv: ["<rootDir>/test/setup-after-env.ts"],
};
