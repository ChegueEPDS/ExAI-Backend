const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  userId: { type: String, index: true, required: false },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true, required: false },
  type: { type: String, required: true },           // pl. 'task-complete'
  title: { type: String, required: true },          // rövid cím
  message: { type: String, required: true },        // megjelenített szöveg
  data: { type: Object, default: {} },              // extra payload (uploadId, counts, stb.)
  status: { type: String, default: 'unread', enum: ['unread','read'] },
  readAt: { type: Date, default: null }
}, { timestamps: true });

NotificationSchema.index({ userId: 1, status: 1, createdAt: -1 });
NotificationSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);