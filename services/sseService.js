function initSse(req, res, options = {}) {
  const heartbeatMs =
    Number.isFinite(Number(options.heartbeatMs)) && Number(options.heartbeatMs) > 0
      ? Math.floor(Number(options.heartbeatMs))
      : 15000;
  const heartbeatEvent = typeof options.heartbeatEvent === 'string' ? options.heartbeatEvent.trim() : '';
  const sendPingImmediately = options.sendPingImmediately !== false;

  const headersAlreadySent = res.headersSent || req?.isSSE;
  if (!headersAlreadySent) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }

  if (res.socket && typeof res.socket.setTimeout === 'function') {
    res.socket.setTimeout(0);
  }

  // Initial comment so proxies start streaming immediately (EventSource compatible).
  // Many clients treat the first bytes as "connection established", so it's helpful to send it early.
  try {
    if (!res.writableEnded) res.write(`:ok\n\n`);
  } catch {}

  function writeHeartbeat() {
    try {
      if (res.writableEnded) return;
      if (heartbeatEvent) {
        res.write(`event: ${heartbeatEvent}\n`);
        res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`);
        return;
      }
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // connection likely closed
    }
  }

  if (sendPingImmediately) writeHeartbeat();

  const heartbeat = setInterval(() => {
    writeHeartbeat();
  }, heartbeatMs);

  const send = (event, payload) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // connection likely closed
    }
  };

  res.on('close', () => {
    clearInterval(heartbeat);
    if (options.setClosedFlag) {
      req[options.setClosedFlag] = true;
    }
    if (typeof options.onClose === 'function') {
      options.onClose({ req, res });
    }
    try { res.end(); } catch { }
  });

  return send;
}

module.exports = { initSse };
