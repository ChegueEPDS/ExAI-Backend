const Certificate = require('../models/certificate');
const { BlobServiceClient } = require('@azure/storage-blob');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Multer konfiguráció a fájl feltöltéshez
const upload = multer({ dest: 'uploads/' });

// Azure Blob Storage inicializálása
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerName = process.env.CONTAINER_NAME || 'certificates';
const containerClient = blobServiceClient.getContainerClient(containerName);

// Fájl feltöltési endpoint
exports.uploadCertificate = async (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(500).send('Fájl feltöltési hiba.');

    try {
      const { certNo, xcondition, specCondition } = req.body;

      if (!certNo) {
        return res.status(400).json({ message: "A certNo kötelező mező!" });
      }

      const filePath = path.resolve(req.file.path);
      const blobName = `${Date.now()}-${req.file.originalname}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      console.log(`Feltöltés az Azure Blob Storage-ra: ${blobName}`);
      await blockBlobClient.uploadFile(filePath);

      // Új Certificate mentése MongoDB-be
      const certificate = new Certificate({
        certNo: certNo,
        fileName: req.file.originalname,
        fileUrl: blockBlobClient.url,
        xcondition: xcondition === 'true', // Boolean konvertálása
        specCondition: specCondition || null
      });
      await certificate.save();

      fs.unlinkSync(filePath); // Helyi fájl törlése
      res.json({
        message: 'Feltöltés sikeres!',
        fileUrl: blockBlobClient.url,
        data: certificate
      });
    } catch (error) {
      console.error('Hiba a feltöltés során:', error);
      res.status(500).send('Hiba a feltöltés során');
    }
  });
};

// Tanúsítványok lekérdezési endpoint
exports.getCertificates = async (req, res) => {
  try {
    const certificates = await Certificate.find();
    res.json(certificates);
  } catch (error) {
    console.error('Hiba a lekérdezés során:', error);
    res.status(500).send('Hiba a lekérdezés során');
  }
};

exports.getCertificateByCertNo = async (req, res) => {
    try {
      const rawCertNo = req.params.certNo;
  
      const certParts = rawCertNo
        .split(/[/,]/) // Splitelés '/' vagy ',' mentén
        .map(part => part.trim()) // Szóközök eltávolítása
        .filter(part => part.length > 0);
  
      console.log('Keresett Certificate részek:', certParts);
  
      const regexConditions = certParts.map(part => {
        const normalizedPart = part.replace(/\s+/g, '').toLowerCase();
        console.log('Regex keresés részletre:', normalizedPart);
        return { certNo: { $regex: new RegExp(normalizedPart.split('').join('.*'), 'i') } };
      });
  
      console.log('Keresési feltételek:', regexConditions);
  
      const certificate = await Certificate.findOne({
        $or: regexConditions
      });
  
      if (!certificate) {
        console.log('Certificate not found');
        return res.status(404).json({ message: 'Certificate not found' });
      }
  
      console.log('Certificate found:', certificate);
      res.json(certificate);
    } catch (error) {
      console.error('Error fetching certificate:', error);
      res.status(500).send('Error fetching certificate');
    }
  };