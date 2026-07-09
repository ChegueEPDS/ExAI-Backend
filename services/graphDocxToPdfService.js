// services/graphDocxToPdfService.js
const { getGraphClient } = require('./graphClient');

function safeName(input, maxLen = 120) {
  const s = String(input || '').trim();
  if (!s) return 'file';
  const cleaned = s
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxLen) || 'file';
}

async function getSiteAndDriveIds(client, hostname, sitePath) {
  const site = await client.api(`/sites/${hostname}:${sitePath}`).get();
  const siteId = site?.id;
  if (!siteId) throw new Error('Graph: failed to resolve siteId');
  const drive = await client.api(`/sites/${siteId}/drive`).get();
  const driveId = drive?.id;
  if (!driveId) throw new Error('Graph: failed to resolve driveId');
  const root = await client.api(`/drives/${driveId}/root`).get();
  const rootId = root?.id;
  if (!rootId) throw new Error('Graph: failed to resolve drive root');
  return { siteId, driveId, rootId };
}

async function listChildren(client, driveId, parentId) {
  const resp = await client.api(`/drives/${driveId}/items/${parentId}/children`).get();
  return resp?.value || [];
}

async function ensureFolderPath(client, driveId, rootId, folderPath) {
  const parts = String(folderPath || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  let parentId = rootId;
  for (const p of parts) {
    const children = await listChildren(client, driveId, parentId);
    const existing = children.find((c) => c?.name === p && c?.folder);
    if (existing?.id) {
      parentId = existing.id;
      continue;
    }
    const created = await client
      .api(`/drives/${driveId}/items/${parentId}/children`)
      .post({ name: p, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
    if (!created?.id) throw new Error('Graph: failed to create folder');
    parentId = created.id;
  }
  return parentId;
}

function officeContentTypeForFileName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (lower.endsWith('.xlsm')) {
    return 'application/vnd.ms-excel.sheet.macroEnabled.12';
  }
  if (lower.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

async function uploadBufferToFolder(client, driveId, folderId, fileName, buffer, contentType = null) {
  const safe = safeName(fileName, 140);
  const item = await client
    .api(`/drives/${driveId}/items/${folderId}:/${encodeURIComponent(safe)}:/content`)
    .header('Content-Type', contentType || officeContentTypeForFileName(safe))
    .put(buffer);
  if (!item?.id) throw new Error('Graph: upload did not return item id');
  return { itemId: item.id, name: item.name || safe };
}

async function downloadPdfForItem(client, driveId, itemId) {
  // Convert on the fly: content?format=pdf
  const arr = await client.api(`/drives/${driveId}/items/${itemId}/content?format=pdf`).responseType('arraybuffer').get();
  return Buffer.from(arr);
}

async function deleteItem(client, driveId, itemId) {
  try {
    await client.api(`/drives/${driveId}/items/${itemId}`).delete();
  } catch {
    // non-fatal
  }
}

/**
 * Convert an Office document buffer to a PDF buffer using Microsoft Graph (app-only).
 * Requires env vars for app credential and access to a SharePoint site drive.
 */
async function convertOfficeBufferToPdfBuffer(fileBuffer, opts = {}) {
  const hostname = opts.hostname || process.env.GRAPH_SP_HOSTNAME || 'exworkss.sharepoint.com';
  const sitePath = opts.sitePath || process.env.GRAPH_SP_SITE_PATH || '/sites/ExAI';
  const folderPath = opts.folderPath || process.env.GRAPH_SP_CONVERT_FOLDER || 'rot-convert';
  const fileName = opts.fileName || `office-${Date.now()}.docx`;
  const contentType = opts.contentType || officeContentTypeForFileName(fileName);

  const client = getGraphClient();
  try {
    const { driveId, rootId } = await getSiteAndDriveIds(client, hostname, sitePath);
    const folderId = await ensureFolderPath(client, driveId, rootId, folderPath);

    const { itemId } = await uploadBufferToFolder(client, driveId, folderId, fileName, fileBuffer, contentType);
    try {
      return await downloadPdfForItem(client, driveId, itemId);
    } finally {
      await deleteItem(client, driveId, itemId);
    }
  } catch (e) {
    // Normalize Graph SDK errors so callers can decide status codes.
    const status =
      e?.statusCode ||
      e?.status ||
      e?.response?.status ||
      e?.error?.statusCode ||
      null;
    const msg = e?.message || e?.error?.message || 'Graph conversion failed';
    const err = new Error(msg);
    err.statusCode = status;
    err.code = e?.code || e?.error?.code || e?.body?.error?.code || null;
    err.details = e?.body?.error || e?.error || null;
    throw err;
  }
}

async function convertDocxBufferToPdfBuffer(docxBuffer, opts = {}) {
  return convertOfficeBufferToPdfBuffer(docxBuffer, {
    ...opts,
    fileName: opts.fileName || `rot-${Date.now()}.docx`,
    contentType: opts.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
}

async function convertXlsxBufferToPdfBuffer(xlsxBuffer, opts = {}) {
  return convertOfficeBufferToPdfBuffer(xlsxBuffer, {
    ...opts,
    fileName: opts.fileName || `workbook-${Date.now()}.xlsx`,
    folderPath: opts.folderPath || process.env.GRAPH_SP_XLSX_CONVERT_FOLDER || process.env.GRAPH_SP_CONVERT_FOLDER || 'itr-convert',
    contentType: opts.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

module.exports = {
  convertOfficeBufferToPdfBuffer,
  convertDocxBufferToPdfBuffer,
  convertXlsxBufferToPdfBuffer
};
