const mongoose = require('mongoose');
const AuditLog = require('../models/auditLog');

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

exports.listAuditLogs = async (req, res) => {
  try {
    const filter = {};
    const search = String(req.query.search || '').trim();
    const action = String(req.query.action || '').trim();
    const tenantId = String(req.query.tenantId || '').trim();
    const actorUserId = String(req.query.actorUserId || '').trim();
    const successRaw = String(req.query.success || '').trim().toLowerCase();
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    if (action) filter.action = action;
    if (tenantId && mongoose.Types.ObjectId.isValid(tenantId)) {
      filter.tenantId = new mongoose.Types.ObjectId(tenantId);
    }
    if (actorUserId && mongoose.Types.ObjectId.isValid(actorUserId)) {
      filter.actorUserId = new mongoose.Types.ObjectId(actorUserId);
    }
    if (successRaw === 'true') filter.success = true;
    if (successRaw === 'false') filter.success = false;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = to;
    }
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { actorEmail: rx },
        { action: rx },
        { path: rx },
        { resourceType: rx },
        { resourceId: rx },
        { requestId: rx },
      ];
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSizeRaw = parseInt(req.query.pageSize, 10) || 25;
    const allowedPageSizes = [10, 25, 50, 100];
    const pageSize = allowedPageSizes.includes(pageSizeRaw) ? pageSizeRaw : 25;
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .populate('tenantId', 'name type')
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    return res.json({
      items: items.map((row) => ({
        id: row._id,
        createdAt: row.createdAt,
        actorUserId: row.actorUserId,
        actorEmail: row.actorEmail,
        actorRole: row.actorRole,
        tenantId: row.tenantId?._id || row.tenantId || null,
        tenantName: row.tenantId?.name || null,
        tenantType: row.tenantId?.type || null,
        action: row.action,
        method: row.method,
        path: row.path,
        routePath: row.routePath,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        statusCode: row.statusCode,
        success: row.success,
        requestId: row.requestId,
        clientType: row.clientType,
        ipHash: row.ipHash,
        userAgentHash: row.userAgentHash,
        metadata: row.metadata,
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('[audit] list failed:', err);
    return res.status(500).json({ error: 'Failed to list audit logs' });
  }
};
