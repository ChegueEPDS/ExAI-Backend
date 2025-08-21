// services/jobBus.js
const { EventEmitter } = require('events');

/**
 * Egyszerű, process-local eseménybusz.
 * Minden threadId-hez külön emittert tartunk.
 */
class JobBus {
  constructor() {
    this.buses = new Map(); // threadId -> EventEmitter
  }

  get(threadId) {
    if (!this.buses.has(threadId)) {
      const em = new EventEmitter();
      // em.setMaxListeners(50); // ha sok kliens kapcsolódhat ugyanarra a threadre
      this.buses.set(threadId, em);
    }
    return this.buses.get(threadId);
  }

  emit(threadId, event, payload) {
    const bus = this.get(threadId);
    bus.emit(event, payload);
  }

  on(threadId, event, handler) {
    const bus = this.get(threadId);
    bus.on(event, handler);
    return () => bus.off(event, handler); // leiratkozó függvény
  }

  // ha egy thread lezárult és már nem kell
  dispose(threadId) {
    const bus = this.buses.get(threadId);
    if (bus) {
      bus.removeAllListeners();
      this.buses.delete(threadId);
    }
  }
}

module.exports = new JobBus();