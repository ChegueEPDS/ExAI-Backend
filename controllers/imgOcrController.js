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
      if (!req.file) {
        throw new Error('No file uploaded.');
      }

      const filePath = req.file.path;
      logger.info(`📥 File uploaded: ${filePath}`);

      const endpoint = process.env.AZURE_OCR_ENDPOINT;
      const subscriptionKey = process.env.AZURE_OCR_KEY;

      if (!endpoint || !subscriptionKey) {
        throw new Error('Missing Azure OCR configuration.');
      }

      const imageBuffer = fs.readFileSync(filePath);

      const response = await axios.post(
        `${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`,
        imageBuffer,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': subscriptionKey,
            'Content-Type': 'application/octet-stream'
          }
        }
      );

      logger.info('🔍 OCR response:', JSON.stringify(response.data, null, 2));

      const blocks = response.data.readResult?.blocks;
      if (!blocks || !Array.isArray(blocks)) {
        throw new Error('No text blocks found in OCR response');
      }

      const extractedText = blocks
        .flatMap(block => block.lines.map(line => line.text))
        .join('\n');

      const formattedText = extractedText
      // Speciális karakterek és HTML entitások javítása
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x2F;/g, "/")
      .replace(/℃/gi, "°C")

      // Ex és római számok korrigálása
      .replace(/(Ex)\s*([MN1il|]{2,3})(A|B|C)/gi, (match, ex, roman, letter) => {
          let correctedRoman = roman.replace(/[MN1il|]/g, "I");
          return `${ex} ${correctedRoman}${letter}`;
      })
      .replace(/(Ex)\s*([a-z]+)([A-Z]{3})/g, '$1 $2 $3')
      .replace(/(Ex)\s*([a-z]+)/g, '$1 $2')
      .replace(/(Ex)(?!\s)(IIA|IIB|IIC|IIIA|IIIB|IIIC)/g, '$1 $2')
      .replace(/(Ex)(?!\s)/gm, '$1 ')

      .replace(/\b[l1]\b/gi, "I")       
        .replace(/\b(1I|iI|Il|lI|ll)\b/gi, "II")  
        .replace(/\b(1II|IlI|lll|lIl)\b/gi, "III")
          
        // MA, MB, MC és változataik cseréje II és III-ra
        .replace(/\b(MA|NA)\b/gi, "IIA")
        .replace(/\b(MB|NB)\b/gi, "IIB")
        .replace(/\b(MC|NC)\b/gi, "IIC")
        
        // IIIA, IIIB, IIIC változatainak javítása
        .replace(/\b(NIIIA|MIIIA|MIIA)\b/gi, "IIIA")
        .replace(/\b(NIIIB|MIIIB|MIIB)\b/gi, "IIIB")
        .replace(/\b(NIC|MIC)\b/gi, "IIIC")

      // Hibás római számok korrigálása
      .replace(/\b(d|de|e|nA|p|q|ia|ib|ic|ma|mb|mc|o|s|tb|t)?([l1|I]{2,3})(A|B|C)\b/gi, (match, prefix, roman, letter) => {
          let correctedRoman = roman.replace(/[l1|I]/g, "I");
          return `${prefix ? prefix + " " : ""}${correctedRoman}${letter}`;
      })
      .replace(/\b11\b/g, 'II')
      .replace(/\b111\b/g, 'III')
      .replace(/\b1\b/g, 'I')

      // Számok és mértékegységek egyesítése
      .replace(/([A-Za-z])(\d{3,4})C/g, '$1 $2°C')
      .replace(/(\d+)\s*([VAKWHz])/g, "$1$2")
      .replace(/IP\s*(\d[X\d])/g, "IP$1")

      // "|T|4|" típusú hibák javítása (T1, T2, stb.)
      .replace(/\|T\|(\d)\|/g, "T$1")

      // Új sorok és egyéb formázások
      .replace(/(Tamb .*?to .*?C)/g, '$1\n')
      .replace(/(S\/N \d+)/g, '$1\n')
      .replace(/([A-Za-z]+):\n(\d+.*)/g, "$1: $2")
      .replace(/\n(?=[a-z])/g, " ") 

      // Többszörös szóközök eltávolítása
      .replace(/\s{2,}/g, " ")
      .trim();

      // Send the analyzed text back to the frontend
      res.json({
        recognizedText: `Show the dataplate information in a table format:<br><br>${formattedText.replace(/\n/g, '<br>')}`
      });

      fs.unlinkSync(filePath);
      logger.info('🗑️ File deleted after processing.');
    } catch (error) {
      logger.error('❌ Error during image upload:', {
        message: error.message,
        responseData: error.response?.data,
        stack: error.stack
      });
      res.status(500).json({ error: 'Image upload failed.' });
    }
  }
];

// OCR - Több kép feltöltése
exports.uploadMultipleImages = [
  upload.array('files', 5),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        console.error('❌ Nincsenek fájlok a kérésben.');
        return res.status(400).json({ error: 'No files uploaded.' });
      }

      console.log(`📸 ${req.files.length} fájl érkezett.`);

      const allText = [];

      for (const file of req.files) {
        console.log(`📥 Fájl feldolgozása: ${file.originalname}`);

        const imageBuffer = fs.readFileSync(file.path);
        const endpoint = process.env.AZURE_OCR_ENDPOINT;
        const key = process.env.AZURE_OCR_KEY;

        if (!endpoint || !key) {
          console.error('❌ Azure OCR endpoint vagy kulcs hiányzik!');
          return res.status(500).json({ error: 'Missing Azure credentials' });
        }

        const response = await axios.post(
          `${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`,
          imageBuffer,
          {
            headers: {
              'Ocp-Apim-Subscription-Key': key,
              'Content-Type': 'application/octet-stream'
            }
          }
        );

        console.log('🔍 OCR válasz:', JSON.stringify(response.data, null, 2));

        const blocks = response.data.readResult?.blocks;
        if (!blocks || !Array.isArray(blocks)) {
          throw new Error('❌ No text blocks found in OCR response');
        }

        const extractedText = blocks
          .flatMap(block => block.lines.map(line => line.text))
          .join('\n');

        allText.push(extractedText);
        fs.unlinkSync(file.path);
      }

      const combinedText = allText.join('\n');
      const formattedText = combinedText
         // Speciális karakterek és HTML entitások javítása
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x2F;/g, "/")
      .replace(/℃/gi, "°C")

      // Ex és római számok korrigálása
      .replace(/(Ex)\s*([MN1il|]{2,3})(A|B|C)/gi, (match, ex, roman, letter) => {
          let correctedRoman = roman.replace(/[MN1il|]/g, "I");
          return `${ex} ${correctedRoman}${letter}`;
      })
      .replace(/(Ex)\s*([a-z]+)([A-Z]{3})/g, '$1 $2 $3')
      .replace(/(Ex)\s*([a-z]+)/g, '$1 $2')
      .replace(/(Ex)(?!\s)(IIA|IIB|IIC|IIIA|IIIB|IIIC)/g, '$1 $2')
      .replace(/(Ex)(?!\s)/gm, '$1 ')

      .replace(/\b[l1]\b/gi, "I")       
        .replace(/\b(1I|iI|Il|lI|ll)\b/gi, "II")  
        .replace(/\b(1II|IlI|lll|lIl)\b/gi, "III")
          
        // MA, MB, MC és változataik cseréje II és III-ra
        .replace(/\b(MA|NA)\b/gi, "IIA")
        .replace(/\b(MB|NB)\b/gi, "IIB")
        .replace(/\b(MC|NC)\b/gi, "IIC")
        
        // IIIA, IIIB, IIIC változatainak javítása
        .replace(/\b(NIIIA|MIIIA|MIIA)\b/gi, "IIIA")
        .replace(/\b(NIIIB|MIIIB|MIIB)\b/gi, "IIIB")
        .replace(/\b(NIC|MIC)\b/gi, "IIIC")

      // Hibás római számok korrigálása
      .replace(/\b(d|de|e|nA|p|q|ia|ib|ic|ma|mb|mc|o|s|tb|t)?([l1|I]{2,3})(A|B|C)\b/gi, (match, prefix, roman, letter) => {
          let correctedRoman = roman.replace(/[l1|I]/g, "I");
          return `${prefix ? prefix + " " : ""}${correctedRoman}${letter}`;
      })
      .replace(/\b11\b/g, 'II')
      .replace(/\b111\b/g, 'III')
      .replace(/\b1\b/g, 'I')

      // Számok és mértékegységek egyesítése
      .replace(/([A-Za-z])(\d{3,4})C/g, '$1 $2°C')
      .replace(/(\d+)\s*([VAKWHz])/g, "$1$2")
      .replace(/IP\s*(\d[X\d])/g, "IP$1")

      // "|T|4|" típusú hibák javítása (T1, T2, stb.)
      .replace(/\|T\|(\d)\|/g, "T$1")

      // Új sorok és egyéb formázások
      .replace(/(Tamb .*?to .*?C)/g, '$1\n')
      .replace(/(S\/N \d+)/g, '$1\n')
      .replace(/([A-Za-z]+):\n(\d+.*)/g, "$1: $2")
      .replace(/\n(?=[a-z])/g, " ") 

      // Többszörös szóközök eltávolítása
      .replace(/\s{2,}/g, " ")
      .trim();

      console.log('✅ OCR kész, válasz visszaküldése...');

      res.json({
        recognizedText: `This text was extracted from several images of the same equipment dataplate using OCR. The text might include duplicates, noise, or misreadings. Please the dataplate information in a table format, extract and organize<br><br>${formattedText.replace(/\n/g, '<br>')}`
      });
    } catch (error) {
      console.error('❌ Hiba történt multi-image OCR közben:', error.response?.data || error.message);
      res.status(500).json({ error: 'Multi-image OCR failed.' });
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
      logger.info("🔍 Extracted Text Before Processing:");
      logger.info(extractedText);

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
              /(?:SPECIFIC CONDITIONS OF USE: YES as shown below:?|SPECIFIC CONDITIONS OF USE:?|SCHEDULE OF LIMITATIONS:|Special Conditions of Use:?|Special conditions for safe use:?)[\s:]*([\s\S]+?)(?=\n(?:Annex:|Attachment to Certificate|TEST & ASSESSMENT REPORTS|This certificate|DETAILS OF CERTIFICATE CHANGES|IECEx|On behalf of|\n[A-Z]+\s[A-Z]+))/i),
            description: extractValue(ocrText, 
              /(?:EQUIPMENT:\s*Equipment and systems covered by this Certificate are as follows:|Ex Component\(s\) covered by this certificate is described below:)\s*([\s\S]+?)(?=\n(?:SPECIFIC CONDITION OF USE:|SCHEDULE OF LIMITATIONS|Annex:|Attachment to Certificate|TEST & ASSESSMENT REPORTS|DETAILS OF CERTIFICATE CHANGES|IECEx|On behalf of|\n[A-Z]{3,}|\n[A-Z]+\s[A-Z]+))/i),    
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
              /\b([A-Za-z0-9\-\/]+)\s+IECEX\s+([A-Za-z0-9\-\/]+(?:\s*[XU])?)\b/i)
              || extractValue(ocrText, 
              /\b(TÜV\s*[A-Za-z]{2,4}\s*\d{2}\s*ATEX\s*\d{3,5}\s*[XU]?)\b/i) // NEW ATEX pattern
              || "-",
          
            manufacturer: extractValue(ocrText, /(?:Manufacturer:|Manufactured by)\s*([^\n\r]+)/) || "-",
          
            equipment: extractValue(ocrText, 
              /(?:Equipment or Protective System:|Equipment:|Product:)\s*([^\n\r]+)/) || "-",
          
            exMarking: (extractValue(ocrText, 
                /(?:\[12\]|\(12\)|The marking of (?:the )?(?:equipment|product|protective system) shall include the following)[:\-\s]*([\s\S]+?)(?=\n\[\d+\]|\n[A-Z]{3,}|This certificate|TÜV|On behalf of)/i
              ) || "")
              .replace(/\nSUL\nEx\n/, 'Ex\n')
              .replace(/@/, 'Ex')
              .replace(/℃/gi, "°C")
              .split(/[\n\s]+/)  // Fontos! Így a szóközzel vagy sortöréssel elválasztott Ex értékek is maradnak
              .map(line => line.trim())
              .filter(line => /(?:Ex|EEx|II|I|IP|T\d|D\sT\d+°C)/.test(line))
              .join(" ")
              .trim()
              || "-",
          
            specialConditions: extractValue(ocrText, 
              /(?:Special conditions for safe use|Specific condition of use|Special Conditions of Use|Special Conditions)[\s:]*([\s\S]+?)(?=\n\[\d+\]|\n[A-Z]{4,}|\nThis certificate|\nTÜV|\nOn behalf of|\n[A-Z]+\s[A-Z]+)/) || "-",
          
            issueDate: extractValue(ocrText, 
              /(?:Issue\s*date\s*[:.\s]*|Issued\s*on\s*)\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{2}[-/]\d{2}[-/]\d{4})/i) || "-"
          };
        }

        return regexes;
      }

      // 🔹 Kivont adatok feldolgozása
      const extractedData = processOcrText(extractedText, certType);
      logger.info("📊 Extracted Data:", extractedData);
      logger.info("📊 Extracted Data:", JSON.stringify(extractedData, null, 2));

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