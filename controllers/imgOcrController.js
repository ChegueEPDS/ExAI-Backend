const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const logger = require('../config/logger');
const DocumentIntelligence = require("@azure-rest/ai-document-intelligence").default;
const { getLongRunningPoller, isUnexpected } = require("@azure-rest/ai-document-intelligence");

// Multer fájlfeltöltés konfiguráció
const upload = multer({ dest: 'uploads/' });


/**********************************/
/*** KÉP FELDOLGOZÁSA AZ OCR API-VAL ***/
/**********************************/
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

/**********************************/
/*** PDF FELDOLGOZÁSA AZ OCR API-VAL ***/
/**********************************/
exports.uploadPdfWithFormRecognizer = [
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        throw new Error('❌ No PDF file uploaded.');
      }

      const { certType } = req.body; // Tanúsítvány típusa (ATEX vagy IECEx)
      if (!certType || (certType !== "ATEX" && certType !== "IECEx")) {
        throw new Error("❌ Missing or invalid certification type. Use 'ATEX' or 'IECEx'.");
      }

      const filePath = req.file.path;
      logger.info(`📄 PDF uploaded: ${filePath}`);

      const pdfBuffer = fs.readFileSync(filePath);
      logger.info(`📄 PDF mérete: ${pdfBuffer.length} bytes`);

      // 🔹 Azure Document Intelligence API beállítása
      const endpoint = process.env.AZURE_FORM_RECOGNIZER_ENDPOINT;
      const key = process.env.AZURE_FORM_RECOGNIZER_KEY;

      if (!endpoint || !key) {
        throw new Error("❌ Missing Azure Form Recognizer credentials.");
      }

      const client = DocumentIntelligence(endpoint, { key });

      logger.info("🚀 Küldés az Azure AI Document Intelligence API-nak...");
      const initialResponse = await client
        .path("/documentModels/{modelId}:analyze", "prebuilt-read")
        .post({
          contentType: "application/pdf",
          body: pdfBuffer
        });

      if (isUnexpected(initialResponse)) {
        throw new Error(`❌ Azure API hiba: ${initialResponse.body.error.message}`);
      }

      logger.info("🔄 Azure AI feldolgozás elindítva, várakozás az eredményekre...");
      const poller = getLongRunningPoller(client, initialResponse);
      const analyzeResult = (await poller.pollUntilDone()).body.analyzeResult;

      if (!analyzeResult) {
        throw new Error("❌ PDF OCR feldolgozás sikertelen.");
      }

      logger.info("✅ Azure AI Document Intelligence OCR befejeződött!");

      const extractedText = analyzeResult.content;
      logger.info(`📄 Extracted text: ${extractedText.substring(0, 500)}...`);

      // 🔹 Szöveg kinyerésére szolgáló függvények (csak itt)
      function extractValue(text, regex) {
        const match = text.match(regex);
        return match ? match[1].trim() : null;
      }

      function processOcrText(ocrText, certType) {
        let regexes;

        if (certType === "IECEx") {
          regexes = {
            certificateNumber: extractValue(ocrText, /\b(IECEx\s+[A-Z]{2,4}\s+\d{2}\.\d{4,5}[UX]?)\b/i),
            status: extractValue(ocrText, 
              /(?:Status:)\s*([\s\S]+?)(?=\n(?:Date of issue:|Issue No:|\n[A-Z]+\s[A-Z]+))/i
            )?.replace(/\n/g, " ").trim(),
            issueDate: extractValue(ocrText, 
              /(?:Date of Issue:)\s*([\s\S]+?)(?=\n(?:Applicant:|\n[A-Z]+\s[A-Z]+))/i
            )?.replace(/\n/g, " ").trim(),
            applicant: extractValue(ocrText, 
              /(?:Applicant:)\s*([\s\S]+?)(?=\n(?:Equipment:|Ex Component:|\n[A-Z]+\s[A-Z]+))/i
            )?.replace(/\n/g, " ").trim(),
            manufacturer: extractValue(ocrText, /(?:Manufacturer:|Manufactured by)\s*([^\n\r]+)/),
            equipment: extractValue(ocrText,
              /(?:Equipment:|Product:|Device:|Ex Component:)\s*([\s\S]+?)(?=\nThis component|Type of Protection:|Marking:|\n[A-Z]+\s[A-Z]+)/i),
            exMarking: extractValue(ocrText, 
              /(?:Ex marking:|Marking:)[\s]*([\s\S]+?)(?=\n(?:Approved for issue|Certificate issued by|TÜV|On behalf of|\n[A-Z]+\s[A-Z]+))/i
            )?.replace(/\n/g, " ").trim(),
            protection: extractValue(ocrText, 
              /Type of Protection:\s*([^\n]*?)(?=\s*Marking:|\n)/i
             )?.trim(),
            specialConditions: extractValue(ocrText, 
              /(?:SPECIFIC CONDITIONS OF USE: YES as shown below:?|SPECIFIC CONDITIONS OF USE:?|Special Conditions of Use:?|Special conditions for safe use:?)[\s:]*([\s\S]+?)(?=\n(?:Annex:|Attachment to Certificate|TEST & ASSESSMENT REPORTS|This certificate|DETAILS OF CERTIFICATE CHANGES|IECEx|On behalf of|\n[A-Z]+\s[A-Z]+))/i),
            description: extractValue(ocrText, 
              /(?:EQUIPMENT:\s*Equipment and systems covered by this Certificate are as follows:\s*)([\s\S]+?)(?=\nSPECIFIC CONDITION OF USE:|SCHEDULE OF LIMITATIONS|Annex:|Attachment to Certificate|TEST & ASSESSMENT REPORTS|DETAILS OF CERTIFICATE CHANGES|IECEx|On behalf of|\n[A-Z]{3,}|\n[A-Z]+\s[A-Z]+)/i),    
          };
        } else {
          regexes = {
            certificateNumber: extractValue(ocrText, 
              /(?:Certificate(?: number| No\.?| N°)?:?)\s*\n*([A-Za-z0-9\-\/\s]+IECEx\s+[A-Za-z0-9\-\/]+)/i) 
              || extractValue(ocrText, 
              /(?:EC[-\s]Type Examination Certificate Number|EU[-\s]Type Examination Certificate number|Certificate(?: number| No\.?| N°)?)\s*\n*(?:Ex\s*\n*)?([A-Za-z0-9\-\/\s]+ATEX[^\n\r]+)/i)
              || extractValue(ocrText, 
              /\b([A-Za-z0-9\-\/]+)\s+ATEX\s+([A-Za-z0-9\-\/]+(?:\s*[XU])?)\b/i)
              || extractValue(ocrText, 
              /\b([A-Za-z0-9\-\/]+)\s+IECEX\s+([A-Za-z0-9\-\/]+(?:\s*[XU])?)\b/i),
            manufacturer: extractValue(ocrText, /(?:Manufacturer:|Manufactured by)\s*([^\n\r]+)/),
            equipment: extractValue(ocrText, /(?:Equipment or Protective System:|Equipment:|Product:)\s*([^\n\r]+)/),
            exMarking: extractValue(ocrText, 
              /(?:\[12\]|\(12\)|The marking of the product shall include the following:)[^\n]*\n+([\s\S]+?)(?=\n\[\d+\]|\n[A-Z]{3,}|This certificate|TÜV|On behalf of)/i
            )
            ?.replace(/\nSUL\nEx\n/, 'Ex\n')
            ?.replace(/@/, 'Ex')
            ?.split("\n")
            ?.map(line => line.trim())
            ?.filter(line => /(?:Ex|EEx|II|I|IP|T\d|D\sT\d+°C)/.test(line))
            ?.join(" ")
            ?.trim(),
            specialConditions: extractValue(ocrText, 
              /(?:Special conditions for safe use|Specific condition of use|Special Conditions of Use|Special Conditions)[\s:]*([\s\S]+?)(?=\n\[\d+\]|\n[A-Z]{4,}|\nThis certificate|\nTÜV|\nOn behalf of|\n[A-Z]+\s[A-Z]+)/),
            issueDate: extractValue(ocrText,
              /(?:Issue\s*date\s*[:.\s]*|Issued\s*on\s*)\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{2}[-/]\d{2}[-/]\d{4})/i)
          };
        }

        return regexes;
      }

      // 🔹 Kivont adatok feldolgozása
      const extractedData = processOcrText(extractedText, certType);
      logger.info("📊 Extracted Data:", extractedData);

      res.json({ recognizedText: extractedText, extractedData });

      await fs.promises.unlink(filePath);
      logger.info('🗑️ PDF fájl törölve.');
    } catch (error) {
      logger.error('❌ Error processing PDF:', error.response ? error.response.data : error.message);
      res.status(500).json({
        error: 'PDF OCR processing failed.',
        details: error.response ? error.response.data : error.message
      });
    }
  }
];