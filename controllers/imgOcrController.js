/*********************************************************/ 
/*** Azure OCR használata RB-s adattábla beolvasásához ***/
/*********************************************************/

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

      formattedText = formattedText
      .replace(/([A-Za-z])(\d{3,4})C/g, '$1 $2°C')
      .replace(/([A-Za-z])(\d{1,2}GD)/g, '$1 $2')
      .replace(/(Tamb .*?to .*?C)/g, '$1\n')
      .replace(/(S\/N \d+)/g, '$1\n')
      .replace(
        /(?<=^|\s)(?:[1izlI]{2,3})(A|B|C)?/gm,
        (match) => match.replace(/[1izl]/g, 'I')
      )
      .replace(
        /(?<=^|\s)(?:[MN1izlI]{2,3})(A|B|C)?/gm,
        (match) => match.replace(/[MN]/g, 'II')
      )
      .replace(/(Ex)(?!\s)/gm, '$1 ')// Add space after 'Ex'
      .replace(/\s{2,}/g, " ") // Többszörös szóköz eltávolítása
      .replace(/\n(?=[a-z])/g, " ") 
      .replace(/\|T\|(\d)\|/g, "T$1")
      .replace(/([A-Za-z]+):\n(\d+.*)/g, "$1: $2")
      .replace(/IP\s*(\d[X\d])/g, "IP$1")
      .replace(/(\d+)\s*([VAKWHz])/g, "$1$2") // Mértékegységek egyesítése
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x2F;/g, "/")
      .trim();

      // Send the analyzed text back to the frontend
      res.json({ recognizedText: `Show the dataplate information in a table format:<br><br>${formattedText.replace(/\n/g, '<br>')}` });

      // Delete the file to free up space
      fs.unlinkSync(filePath);
      logger.info('File successfully deleted.');
    } catch (error) {
      logger.error('Error during image upload:', error.response ? error.response.data : error.message);
      res.status(500).json({ error: 'Image upload failed.' });
    }
  }
];