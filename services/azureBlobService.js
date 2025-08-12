const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_BLOB_CONTAINER_NAME || 'certificates';

const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

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
  }
};