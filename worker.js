require('dotenv').config();

const util = require('util');
const express = require('express');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const systemSettingsStore = require('./services/systemSettingsStore');
const { seedInitialSuperAdminIfEmpty } = require('./services/bootstrapSuperAdmin');
const { startWorkerRuntime, stopWorkerRuntime, backgroundJobsDisabled } = require('./services/workerRuntime');

let server = null;
let shuttingDown = false;
let shutdownPromise = null;

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
  if (typeof args[0] === 'string') {
    return util.formatWithOptions({ depth: 5, colors: false }, ...args);
  }
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

  await systemSettingsStore.start();

  const result = startWorkerRuntime();
  if (!result.started) {
    logger.warn('[worker] Worker runtime did not start', {
      reason: result.reason,
      backgroundJobsDisabled: backgroundJobsDisabled()
    });
  }

  const app = express();
  app.get('/health', (_req, res) => {
    const ready = !shuttingDown && mongoose.connection.readyState === 1 && result.started;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      role: 'worker',
      backgroundJobsDisabled: backgroundJobsDisabled(),
      shuttingDown
    });
  });

  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  server = app.listen(port, host, () => {
    logger.info(`[worker] Health endpoint listening on http://${host}:${port}`);
  });

  server.requestTimeout = Math.max(30_000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 120_000));
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
}

function closeHttpServer() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    const graceMs = Math.max(30_000, Number(process.env.SHUTDOWN_GRACE_MS || 10 * 60_000));
    logger.warn('[worker] shutdown started', { reason, graceMs });
    let forced = false;
    await Promise.race([
      Promise.allSettled([
        closeHttpServer(),
        stopWorkerRuntime({ drainTimeoutMs: graceMs }),
      ]),
      new Promise((resolve) => setTimeout(() => {
        forced = true;
        resolve();
      }, graceMs)),
    ]);
    systemSettingsStore.stop();
    await mongoose.connection.close(false).catch((err) => {
      logger.error('[worker] MongoDB close failed', { error: err?.message || String(err) });
    });
    logger.warn('[worker] shutdown completed', { reason, forced });
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  void shutdown('uncaughtException', 1);
});

main().catch((err) => {
  logger.error(`[worker] startup failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
