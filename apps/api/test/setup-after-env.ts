/**
 * Jest setup file run after environment is loaded (but before tests).
 * Runs once per test file.
 */

// Silence pino during tests unless LOG_LEVEL is explicitly set
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "silent";
}
