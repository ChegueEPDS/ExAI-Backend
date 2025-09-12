// lib/notifications/bus.js
const { EventEmitter } = require('events');

class NotificationsBus extends EventEmitter {
  emitTo(userId, event, payload = {}) {
    const msg = { userId, tenantId: null, event, payload, ts: new Date().toISOString() };
    this.emit(`notify:${userId}`, msg);
    this.emit('notify:*', msg);
  }
  emitToUser(userId, event, payload = {}) {
    return this.emitTo(userId, event, payload);
  }
  // 🔹 ÚJ: tenant-csatorna
  emitToTenant(tenantId, event, payload = {}) {
    const msg = { userId: null, tenantId, event, payload, ts: new Date().toISOString() };
    this.emit(`notify:tenant:${tenantId}`, msg);
    this.emit('notify:*', msg);
  }
  emitBroadcast(event, payload = {}) {
    const msg = { userId: null, tenantId: null, event, payload, ts: new Date().toISOString() };
    this.emit('notify:*', msg);
  }
}

const bus = new NotificationsBus();
bus.setMaxListeners(1000);
module.exports = bus;