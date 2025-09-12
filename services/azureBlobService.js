const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
  SASIPRange
} = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_BLOB_CONTAINER_NAME || 'certificates';

const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

// ---- Helpers to normalize blob names and build URLs ----
/**
 * Normalize an incoming blob identifier (URL or relative path) to a
 * container-relative path like "folder/name.ext". Any SAS or query string
 * will be stripped. Leading slashes are removed.
 */
function toBlobPath(input) {
  if (!input) return '';
  const s = String(input).trim();
  try {
    // If full URL, cut after the container segment
    if (s.startsWith('http://') || s.startsWith('https://')) {
      const u = new URL(s);
      // container URL base (no trailing slash)
      const contBase = containerClient.url.replace(/\/+$/,'');
      const full = u.origin + u.pathname; // drop query
      if (full.startsWith(contBase + '/')) {
        return full.slice((contBase + '/').length).replace(/^\/+/, '');
      }
      // Fallback: try to find the container segment in the path
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => p === containerClient.containerName);
      if (idx !== -1) {
        return parts.slice(idx + 1).join('/');
      }
      // If we can't detect, return the last path segment
      return parts.pop() || '';
    }
    // If already looks like a path, drop any query and leading slashes
    const qIdx = s.indexOf('?');
    const noQuery = qIdx !== -1 ? s.slice(0, qIdx) : s;
    return noQuery.replace(/^\/+/, '');
  } catch {
    // Non-URL strings
    const qIdx = s.indexOf('?');
    const noQuery = qIdx !== -1 ? s.slice(0, qIdx) : s;
    return noQuery.replace(/^\/+/, '');
  }
}

/**
 * Return the HTTPS URL of a blob (without SAS).
 */
function getBlobUrl(blobPath) {
  const p = toBlobPath(blobPath);
  return containerClient.getBlockBlobClient(p).url;
}

// Helper: parse AccountName/AccountKey from connection string for SAS generation
function parseConnStr(connStr) {
  const entries = String(connStr || '')
    .split(';')
    .map(seg => {
      const idx = seg.indexOf('=');
      if (idx === -1) return null;             // nincs kulcs=érték
      const key = seg.slice(0, idx).trim();
      const val = seg.slice(idx + 1).trim();   // NE daraboljuk tovább a Base64-t!
      if (!key) return null;
      return [key, val];
    })
    .filter(Boolean);

  const parts = Object.fromEntries(entries);
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
  };
}

/**
 * Create a short-lived, read-only SAS URL for a blob.
 * NOTE: SAS URLs are bearer links; keep TTL short and optionally bind to IP.
 * @param {string} blobName
 * @param {object} opts
 * @param {number} [opts.ttlSeconds=300]
 * @param {string} [opts.ip] IPv4 to bind (optional)
 * @param {string} [opts.filename] Download filename (Content-Disposition)
 * @param {string} [opts.contentType] MIME type (e.g. application/pdf)
 * @param {boolean} [opts.httpsOnly=true]
 * @returns {Promise<string>} SAS URL
 */
async function getReadSasUrl(blobName, opts = {}) {
  const {
    ttlSeconds = 300,
    ip,
    filename,
    contentType,
    httpsOnly = true
  } = opts;

  const { accountName, accountKey } = parseConnStr(process.env.AZURE_STORAGE_CONNECTION_STRING);
  if (!accountName || !accountKey) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING must contain AccountName and AccountKey to generate SAS.');
  }

  const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
  const blobClient = containerClient.getBlobClient(blobName);

  // clock skew tolerance
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(startsOn.getTime() + Math.max(30, ttlSeconds) * 1000);

  const permissions = BlobSASPermissions.parse('r');

  const sasParams = generateBlobSASQueryParameters(
    {
      containerName: containerClient.containerName,
      blobName,
      permissions,
      startsOn,
      expiresOn,
      protocol: httpsOnly ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
      ipRange: ip ? new SASIPRange(ip, ip) : undefined,
      contentDisposition: filename ? `attachment; filename="${filename}"` : undefined,
      contentType: contentType || undefined
    },
    sharedKey
  );

  return `${blobClient.url}?${sasParams.toString()}`;
}

/**
 * Delete all blobs under a given container-relative prefix (e.g. "dxf/<jobId>/").
 * Returns a summary with the number of deleted blobs.
 * @param {string} prefix
 * @returns {Promise<{ deleted: number }>}
 */
async function deletePrefix(prefix) {
  const pfx = toBlobPath(prefix).replace(/^\/+/, '');
  if (!pfx) return { deleted: 0 };
  let deleted = 0;

  // list and delete iteratively; continue on individual errors
  for await (const item of containerClient.listBlobsFlat({ prefix: pfx })) {
    try {
      const block = containerClient.getBlockBlobClient(item.name);
      const resp = await block.deleteIfExists();
      if (resp.succeeded) deleted++;
    } catch (e) {
      try { console.warn('[blob] deletePrefix item failed:', item.name, e?.message || e); } catch {}
    }
  }
  try { console.info('[blob] deletePrefix done', { prefix: pfx, deleted }); } catch {}
  return { deleted };
}

module.exports = {
  async uploadFile(filePath, blobName, contentType) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const options = contentType
      ? { blobHTTPHeaders: { blobContentType: contentType } }
      : undefined; // if not provided, Azure will use default (application/octet-stream)
    const uploadBlobResponse = await blockBlobClient.uploadFile(filePath, options);
    return uploadBlobResponse;
  },

  async downloadFile(blobName, downloadPath) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const downloadBlockBlobResponse = await blockBlobClient.downloadToFile(downloadPath);
    return downloadBlockBlobResponse;
  },

  async deleteFile(blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const deleteResponse = await blockBlobClient.deleteIfExists();
    return deleteResponse;
  },

  async renameFile(oldBlobName, newBlobName) {
    const sourceBlob = containerClient.getBlobClient(oldBlobName);
    const targetBlob = containerClient.getBlockBlobClient(newBlobName);

    const copyPoller = await targetBlob.beginCopyFromURL(sourceBlob.url);
    await copyPoller.pollUntilDone();
    await sourceBlob.deleteIfExists();

    return { renamed: true };
  },

  /**
   * Upload an in-memory Buffer as a blob.
   * @param {string} blobNameOrPath - URL or container-relative path where to store.
   * @param {Buffer|Uint8Array} buffer
   * @param {string} [contentType='application/octet-stream']
   * @param {{ metadata?: Record<string,string> }} [opts]
   * @returns {Promise<string>} The container-relative path of the uploaded blob.
   */
  async uploadBuffer(blobNameOrPath, buffer, contentType = 'application/octet-stream', opts = {}) {
    const blobPath = toBlobPath(blobNameOrPath);
    if (!blobPath) throw new Error('uploadBuffer: missing blob name/path');
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

    // optional debug logs
    try {
      console.info('[blob] uploadBuffer ->', {
        container: containerClient.containerName,
        blobPath,
        bytes: buffer ? (buffer.byteLength || buffer.length || 0) : 0,
        contentType
      });
    } catch {}

    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: contentType },
      metadata: opts.metadata || undefined
    });

    return blobPath; // return relative path for DB storage
  },

  

  getReadSasUrl,
  deletePrefix,
  getBlobUrl,
  toBlobPath
};