const { MongoMemoryServer } = require('mongodb-memory-server');
const { spawn } = require('node:child_process');
const { request } = require('undici');
const fs = require('node:fs');
const path = require('node:path');

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const { statusCode, body } = await request(`${baseUrl}/health`, { method: 'GET' });
      const text = await body.text();
      if (statusCode === 200 && text.trim() === 'OK') return;
      lastError = new Error(`Unexpected /health response: ${statusCode} ${text}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }

  throw lastError || new Error('Timed out waiting for /health');
}

async function main() {
  const port = Number(process.env.PORT || 0) || 0;
  const requestedFrontendDist = process.env.FRONTEND_DIST;
  const inferredFrontendDistRoot = path.resolve(__dirname, '..', '..', 'EPDS', 'dist', 'ex-gpt');
  const inferredFrontendDistBrowser = path.join(inferredFrontendDistRoot, 'browser');
  const frontendDist = requestedFrontendDist
    ? path.resolve(requestedFrontendDist)
    : (fs.existsSync(inferredFrontendDistBrowser) ? inferredFrontendDistBrowser
      : (fs.existsSync(inferredFrontendDistRoot) ? inferredFrontendDistRoot : undefined));

  const mongod = await MongoMemoryServer.create();
  const mongoUri = mongod.getUri();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DISABLE_BACKGROUND_JOBS: '1',
    MONGO_URI: mongoUri,
    PORT: String(port || 3100),
    ...(frontendDist ? { FRONTEND_DIST: frontendDist } : {})
  };

  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit'
  });

  const baseUrl = `http://127.0.0.1:${env.PORT}`;

  try {
    await waitForHealth(baseUrl);

    if (frontendDist) {
      const { statusCode, body } = await request(`${baseUrl}/`, { method: 'GET' });
      const html = await body.text();
      if (statusCode !== 200) {
        throw new Error(`Unexpected GET / status: ${statusCode}`);
      }
      if (!html.includes('<app-root') && !html.includes('app-root')) {
        throw new Error('Frontend index.html did not look like an Angular app (missing app-root)');
      }
      // eslint-disable-next-line no-console
      console.log(`[smoke] Frontend served from ${frontendDist}`);
    } else {
      // eslint-disable-next-line no-console
      console.log('[smoke] FRONTEND_DIST not set and EPDS dist not found; skipping frontend check');
    }

    // eslint-disable-next-line no-console
    console.log('[smoke] OK');
  } finally {
    child.kill('SIGTERM');
    await mongod.stop();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke] FAILED:', err);
  process.exitCode = 1;
});
