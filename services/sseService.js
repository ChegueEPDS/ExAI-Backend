function initSse(req, res, options = {}) {
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

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // connection likely closed
    }
  }, 15000);

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
