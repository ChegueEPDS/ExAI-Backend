const owners = new Map(); // key: resourceId (pl. uploadId), value: userId

module.exports = {
  set(resourceId, userId) { owners.set(resourceId, userId); },
  get(resourceId) { return owners.get(resourceId) || null; },
  delete(resourceId) { owners.delete(resourceId); },
  has(resourceId) { return owners.has(resourceId); },
};