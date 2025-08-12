const { EventEmitter } = require('events');

/**
 * NotificationsBus
 * - emitTo(userId, event, payload): adott user csatornájára
 * - emitBroadcast(event, payload): broadcast
 * Csatornák:
 *   - notify:<userId>
 *   - notify:*
 */
class NotificationsBus extends EventEmitter {
  emitTo(userId, event, payload = {}) {
    const msg = { userId, event, payload, ts: new Date().toISOString() };
    this.emit(`notify:${userId}`, msg);
    this.emit('notify:*', msg);
  }
  emitToUser(userId, event, payload = {}) {
    return this.emitTo(userId, event, payload);
  }
  emitBroadcast(event, payload = {}) {
    const msg = { userId: null, event, payload, ts: new Date().toISOString() };
    this.emit('notify:*', msg);
  }
}

const bus = new NotificationsBus();
bus.setMaxListeners(1000);
module.exports = bus;