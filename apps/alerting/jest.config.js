export default {
  displayName: "@highwood/alerting",
  testEnvironment: "node",
  rootDir: "./",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  moduleFileExtensions: ["js", "json", "ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  preset: "ts-jest",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "ES2020",
          moduleResolution: "node",
          target: "ES2022",
          esModuleInterop: true,
          skipLibCheck: true,
          baseUrl: ".",
          paths: {
            "@highwood/contracts": ["../../packages/contracts/src/index.ts"],
            "@highwood/contracts/*": ["../../packages/contracts/src/*"],
          },
        },
      },
    ],
  },
  testTimeout: 30000,
  maxWorkers: 1,
};
