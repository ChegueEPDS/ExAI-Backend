require('dotenv').config();

const express = require('express');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const systemSettingsStore = require('./services/systemSettingsStore');
const { seedInitialSuperAdminIfEmpty } = require('./services/bootstrapSuperAdmin');
const { startWorkerRuntime, backgroundJobsDisabled } = require('./services/workerRuntime');

function formatConsoleArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatConsoleArgs(args) {
  return args.map(formatConsoleArg).join(' ');
}

console.log = (...args) => {
  logger.info(formatConsoleArgs(args));
};
console.warn = (...args) => {
  logger.warn(formatConsoleArgs(args));
};
console.error = (...args) => {
  logger.error(formatConsoleArgs(args));
};

async function main() {
  await connectDB();
  logger.info('[worker] Database connected successfully');
  await seedInitialSuperAdminIfEmpty();

  systemSettingsStore.start();

  const result = startWorkerRuntime();
  if (!result.started) {
    logger.warn('[worker] Worker runtime did not start', {
      reason: result.reason,
      backgroundJobsDisabled: backgroundJobsDisabled()
    });
  }

  const app = express();
  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      role: 'worker',
      backgroundJobsDisabled: backgroundJobsDisabled()
    });
  });

  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    logger.info(`[worker] Health endpoint listening on http://${host}:${port}`);
  });

  server.requestTimeout = 0;
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
});

main().catch((err) => {
  logger.error(`[worker] startup failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
