/********************************************************/ 
/*** Az OpenAI Vision API használata képfelismeréshez ***/
/********************************************************/

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');

// Betöltjük a .env változókat
dotenv.config();

// Konstansok meghatározása
const UPLOADS_DIR = path.join(__dirname, '../uploads');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const UPLOADS_URL = `${BASE_URL}/uploads`;

// Ellenőrizzük, hogy az upload mappa létezik-e, és ha nem, létrehozzuk
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Képfeltöltés kezelése
const uploadImage = async (req, res) => {
    try {
        const image = req.file;

        if (!image) {
            return res.status(400).json({ status: 'error', message: 'Kép feltöltése sikertelen.' });
        }

        // Ellenőrizzük a fájl típusát
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
        if (!allowedTypes.includes(image.mimetype)) {
            return res.status(400).json({ status: 'error', message: 'Csak JPEG, PNG és GIF formátumok engedélyezettek.' });
        }

        // Egyedi fájlnév generálása
        const uniqueName = `${Date.now()}_${image.originalname}`;
        const uploadPath = path.join(UPLOADS_DIR, uniqueName);

        // Fájl mentése
        fs.writeFileSync(uploadPath, image.buffer);

        const imageUrl = `${UPLOADS_URL}/${uniqueName}`;
        res.status(200).json({ status: 'success', image_url: imageUrl });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Hiba történt a kép feltöltése során.', error: error.message });
    }
};

// OpenAI API hívás
const analyzeImages = async (req, res) => {
    try {
        const { image_urls, user_input } = req.body;

        if (!image_urls || !image_urls.length) {
            return res.status(400).json({ status: 'error', message: 'Nincsenek kép URL-ek megadva.' });
        }

        const userInput = user_input || "Mit látsz a képén?";
        const apiUrl = 'https://api.openai.com/v1/chat/completions';

        const images = image_urls.map((url) => ({
            type: 'image_url',
            image_url: { url },
        }));

        const data = {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: userInput,
                        },
                        ...images,
                    ],
                },
            ],
            max_tokens: 4096,
        };

        const response = await axios.post(apiUrl, data, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
        });

        const result = response.data.choices[0]?.message?.content || 'No result from API';
        res.status(200).json({ status: 'success', result });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Hiba az OpenAI API hívás során.', error: error.message });
    }
};

module.exports = {
    uploadImage,
    analyzeImages,
};