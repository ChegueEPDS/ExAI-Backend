/********************************************************/ 
/*** Az OpenAI Vision API használata képfelismeréshez ***/
/********************************************************/

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const sharp = require('sharp');

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

        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
        if (!allowedTypes.includes(image.mimetype)) {
            return res.status(400).json({ status: 'error', message: 'Csak JPEG, PNG és GIF formátumok engedélyezettek.' });
        }

        // Egyedi fájlnév generálása
        const uniqueName = `${Date.now()}_${image.originalname}`;
        const uploadPath = path.join(UPLOADS_DIR, uniqueName);

        // Ha a fájlméret meghaladja az 5MB-ot, skálázd le
        if (image.size > 5 * 1024 * 1024) {
            console.log('A kép nagyobb mint 5MB, átméretezés...');

            let resizedImageBuffer = await sharp(image.buffer)
                .resize({ width: 1920 })  // Ha a kép szélesebb, mint 1920px, akkor átméretezés
                .jpeg({ quality: 100 })    // JPEG tömörítés %-os minőségre
                .toBuffer();

            // Ellenőrizzük újra a méretet, ha még mindig nagy, csökkentsük a minőséget
            while (resizedImageBuffer.length > 5 * 1024 * 1024) {
                resizedImageBuffer = await sharp(resizedImageBuffer)
                    .jpeg({ quality: 70 }) // Tovább csökkentjük a minőséget, ha kell
                    .toBuffer();
            }

            // A kisebb méretű fájl mentése
            fs.writeFileSync(uploadPath, resizedImageBuffer);
        } else {
            // Ha a fájl kisebb mint 5MB, akkor mentjük az eredeti verziót
            fs.writeFileSync(uploadPath, image.buffer);
        }

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

        // Képek törlése az uploads mappából
        image_urls.forEach((imageUrl) => {
            const filename = imageUrl.split('/').pop(); // Fájlnév kinyerése az URL-ből
            const filePath = path.join(UPLOADS_DIR, filename);

            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`Hiba történt a fájl törlésekor: ${filename}`, err);
                } else {
                    console.log(`✅ Törölve: ${filename}`);
                }
            });
        });

        res.status(200).json({ status: 'success', result });

    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Hiba az OpenAI API hívás során.', error: error.message });
    }
};

module.exports = {
    uploadImage,
    analyzeImages,
};