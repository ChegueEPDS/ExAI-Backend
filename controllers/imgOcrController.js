// Import dependencies
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const logger = require('../config/logger');

// Configure multer for image uploads
const upload = multer({ dest: 'uploads/' });

// Controller function for uploading and processing images using Azure OCR 4.0
exports.uploadImage = [
  upload.single('file'),
  async (req, res) => {
    try {
      // Check if a file is provided
      if (!req.file) {
        throw new Error('No file uploaded.');
      }

      const filePath = req.file.path;
      logger.info(`File uploaded: ${filePath}`);

      // Set up Azure OCR API 4.0 configuration
      const endpoint = process.env.AZURE_OCR_ENDPOINT;
      const subscriptionKey = process.env.AZURE_OCR_KEY;

      const imageBuffer = fs.readFileSync(filePath);

      // Call Azure OCR API 4.0
      const response = await axios.post(
        `${endpoint}/computervision/imageanalysis:analyze?api-version=2023-02-01-preview&features=read`,
        imageBuffer,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': subscriptionKey,
            'Content-Type': 'application/octet-stream'
          }
        }
      );

      const textData = response.data.readResult;
      logger.info('Image text recognition result: ', textData);

      // Extract recognized text from the response
      const extractedText = textData.pages.map(page =>
        page.lines.map(line => line.content).join('\n')
      ).join('\n');

      // Manual corrections and formatting to maintain original structure
      let formattedText = extractedText;

      formattedText = formattedText.replace(/([A-Za-z])(\d{3,4})C/g, '$1 $2°C');
      formattedText = formattedText.replace(/([A-Za-z])(\d{1,2}GD)/g, '$1 $2');
      formattedText = formattedText.replace(/(Tamb .*?to .*?C)/g, '$1\n');
      formattedText = formattedText.replace(/(S\/N \d+)/g, '$1\n');
      formattedText = formattedText.replace(/(CE & II2G .*?T4)/g, '$1\n');


      // Send the analyzed text back to the frontend
      res.json({ recognizedText: `<strong>Kérlek foglald össze az adattábla tartalmát egy táblázatban! </strong><br><br>${formattedText.replace(/\n/g, '<br>')}` });

      // Delete the file to free up space
      fs.unlinkSync(filePath);
      logger.info('File successfully deleted.');
    } catch (error) {
      logger.error('Error during image upload:', error.response ? error.response.data : error.message);
      res.status(500).json({ error: 'Image upload failed.' });
    }
  }
];