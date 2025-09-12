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

// Helpers for multi-tenant uploads
function getTenantId(req) {
  return (req?.scope?.tenantId ? String(req.scope.tenantId) : 'public');
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function getBaseUrl(req) {
  // Prefer request host to avoid stale BASE_URL across tenants/environments
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  if (host) return `${proto}://${host}`;
  return process.env.BASE_URL || 'http://localhost:3000';
}

// Konstansok meghatározása – csak a gyökér mappa, a tenant alkönyvtár kérésenként készül el
const UPLOADS_DIR = path.join(__dirname, '../uploads');

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

        // Egyedi fájlnév generálása + tenant alkönyvtár
        const tenantId = getTenantId(req);
        const tenantDir = path.join(UPLOADS_DIR, tenantId);
        ensureDir(tenantDir);
        const uniqueName = `${Date.now()}_${image.originalname}`;
        const uploadPath = path.join(tenantDir, uniqueName);

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

        const baseUrl = getBaseUrl(req);
        const imageUrl = `${baseUrl}/uploads/${tenantId}/${uniqueName}`;
        res.status(200).json({ status: 'success', image_url: imageUrl });
    } catch (error) {
        console.error('uploadImage error:', error);
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

        const userInput = user_input || "What is opn the image? Please explain!";
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

        // Képek törlése az uploads mappából (tenant-alkönyvtárban)
        image_urls.forEach((urlStr) => {
          try {
            const u = new URL(urlStr, getBaseUrl(req));
            // Várt minta: /uploads/<tenantId>/<filename>
            const parts = u.pathname.split('/').filter(Boolean);
            const idx = parts.indexOf('uploads');
            const tenantId = (idx !== -1 && parts[idx + 1]) ? parts[idx + 1] : getTenantId(req);
            const filename = parts.pop();
            if (!filename) return;
            const filePath = path.join(UPLOADS_DIR, tenantId, filename);
            fs.unlink(filePath, (err) => {
              if (err) {
                console.warn(`⚠️ Nem sikerült törölni: ${filePath} –`, err.message);
              } else {
                console.log(`✅ Törölve: ${filePath}`);
              }
            });
          } catch (e) {
            console.warn('⚠️ Érvénytelen kép URL, törlés kihagyva:', urlStr);
          }
        });

        res.status(200).json({ status: 'success', result });

    } catch (error) {
        console.error('analyzeImages error:', error);
        res.status(500).json({ status: 'error', message: 'Hiba az OpenAI API hívás során.', error: error.message });
    }
};

module.exports = {
    uploadImage,
    analyzeImages,
};