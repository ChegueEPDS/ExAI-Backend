require('dotenv').config(); // Környezeti változók betöltése
const Jimp = require('jimp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const conversationController = require('./conversationController');

const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT;
const PREDICTION_KEY = process.env.PREDICTION_KEY;

// Kép annotálása bounding boxokkal
async function annotateImage(imagePath, predictions, outputPath, borderThickness = 13) {
    try {
        const image = await Jimp.read(imagePath);
        const imageWidth = image.bitmap.width;
        const imageHeight = image.bitmap.height;
        const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE); // Betűtípus betöltése

        predictions.forEach(prediction => {
            if (prediction.probability > 0.5) { // Csak a magas valószínűségű predikciókat rajzoljuk
                const { left, top, width, height } = prediction.boundingBox;

                const x = Math.floor(left * imageWidth);
                const y = Math.floor(top * imageHeight);
                const boxWidth = Math.floor(width * imageWidth);
                const boxHeight = Math.floor(height * imageHeight);

                // Draw top and bottom borders with thickness
                for (let t = 0; t < borderThickness; t++) {
                    for (let i = 0; i < boxWidth; i++) {
                        // Top border
                        image.setPixelColor(Jimp.rgbaToInt(255, 0, 0, 255), x + i, y + t);
                        // Bottom border
                        image.setPixelColor(Jimp.rgbaToInt(255, 0, 0, 255), x + i, y + boxHeight - 1 - t);
                    }
                }

                // Draw left and right borders with thickness
                for (let t = 0; t < borderThickness; t++) {
                    for (let i = 0; i < boxHeight; i++) {
                        // Left border
                        image.setPixelColor(Jimp.rgbaToInt(255, 0, 0, 255), x + t, y + i);
                        // Right border
                        image.setPixelColor(Jimp.rgbaToInt(255, 0, 0, 255), x + boxWidth - 1 - t, y + i);
                    }
                }

                // Add a red background for the text with 5px margin
                const margin = 5;
                const probabilityText = `${(prediction.probability * 100).toFixed(2)}%`; // Százalék formázása
                const textWidth = Jimp.measureText(font, probabilityText); // Szöveg szélessége
                const textHeight = Jimp.measureTextHeight(font, probabilityText); // Szöveg magassága

                // Draw red rectangle as background
                image.scan(
                    x, y, 
                    textWidth + margin * 2, 
                    textHeight + margin * 2, 
                    (xPos, yPos, idx) => {
                        image.bitmap.data[idx] = 255; // Red
                        image.bitmap.data[idx + 1] = 0; // Green
                        image.bitmap.data[idx + 2] = 0; // Blue
                        image.bitmap.data[idx + 3] = 255; // Fully opaque
                    }
                );

                // Add the probability as text on the rectangle
                image.print(font, x + margin, y + margin, probabilityText); // Szöveg elhelyezése
            }
        });

        // Mentse az annotált képet
        await image.writeAsync(outputPath);
        console.log('Image annotation complete:', outputPath);
    } catch (error) {
        console.error('Error during image annotation:', error.message);
        throw error;
    }
}

// Predikció kezelése
exports.processImage = async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        console.error('Error: No file uploaded.');
        return res.status(400).json({ error: 'Nincs feltöltött kép.' });
      }
  
      const imagePath = file.path;
      const outputPath = path.join(__dirname, `../${process.env.UPLOAD_FOLDER}/annotated-${file.filename}`);
  
      // Log debug information
      console.log('File uploaded:', file.originalname);
      console.log('Temporary file path:', imagePath);
      console.log('Output path for annotated image:', outputPath);
      console.log('Azure Endpoint:', AZURE_ENDPOINT);
      console.log('Prediction Key:', PREDICTION_KEY);
  
      // Send image to Azure for prediction
      console.log('Sending image to Azure for prediction...');
      const azureResponse = await axios.post(AZURE_ENDPOINT, fs.readFileSync(imagePath), {
        headers: {
          'Prediction-Key': PREDICTION_KEY,
          'Content-Type': 'application/json',
        },
      });
  
      console.log('Azure response received:', azureResponse.data);
      const predictions = azureResponse.data.predictions;
  
      // Annotate the image with bounding boxes
      console.log('Annotating the image...');
      await annotateImage(imagePath, predictions, outputPath);
  
      console.log('Annotation complete. Returning response to the client...');
      res.status(200).json({
        message: 'Predikció és annotálás sikeres.',
        predictions,
        annotatedImage: `${process.env.BASE_URL}/${process.env.UPLOAD_FOLDER}/annotated-${file.filename}`,
    });
  
      // Cleanup: Delete the original uploaded file
      console.log('Deleting temporary file:', imagePath);
      fs.unlinkSync(imagePath);
    } catch (error) {
      console.error('Hiba a predikció során:', error.message);
      if (error.response) {
        console.error('Azure response data:', error.response.data);
      } else {
        console.error('No additional response data.');
      }
      res.status(500).json({ error: 'Hiba történt a predikció során.' });
    }
  };