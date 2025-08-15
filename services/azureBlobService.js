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

module.exports = {
  async uploadFile(filePath, blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const uploadBlobResponse = await blockBlobClient.uploadFile(filePath);
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

  getReadSasUrl
};