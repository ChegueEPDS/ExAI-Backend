const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Fájlok ideiglenes tárolása az "uploads" mappában
const upload = multer({ dest: 'uploads/' });

router.post('/upload', upload.single('file'), (req, res) => {
  const dxfPath = path.resolve(req.file.path);

  const python = spawn('python3', ['python/process_dxf.py', dxfPath]);

  let data = '';
  let error = '';

  python.stdout.on('data', chunk => data += chunk);
  python.stderr.on('data', chunk => error += chunk);

  python.on('close', code => {
    fs.unlinkSync(dxfPath); // Törli az ideiglenes fájlt

    if (code !== 0) {
      return res.status(500).json({ error });
    }

    try {
      const result = JSON.parse(data);
      res.json(result);
      cleanupResults(); // 🧹 csak ha minden rendben lefutott
    } catch (e) {
      res.status(500).json({ error: 'Hibás JSON a Python szkriptből.' });
    }
  });
});

function cleanupResults() {
  const resultDir = path.resolve('results');
  const files = fs.readdirSync(resultDir);

  const now = Date.now();
  const maxAgeMs = 3 * 60 * 60 * 1000; // 3 óra

  const groups = {
    excel: [],
    json: []
  };

  // Csoportosítsuk a fájlokat típus szerint
  for (const file of files) {
    const fullPath = path.join(resultDir, file);

    if (file.startsWith('output_') && file.endsWith('.xlsx')) {
      const { birthtimeMs } = fs.statSync(fullPath);
      groups.excel.push({ path: fullPath, time: birthtimeMs });
    }

    if (file.startsWith('debug_unknowns_') && file.endsWith('.json')) {
      const { birthtimeMs } = fs.statSync(fullPath);
      groups.json.push({ path: fullPath, time: birthtimeMs });
    }
  }

  // Mindkét típusra: hagyd meg a legfrissebbet, töröld a többit ha 3 óránál idősebb
  for (const group of Object.values(groups)) {
    if (group.length <= 1) continue;

    // Idő szerint csökkenő sorrend
    group.sort((a, b) => b.time - a.time);

    // Az első marad (legfrissebb)
    const [, ...oldFiles] = group;

    for (const file of oldFiles) {
      if ((now - file.time) > maxAgeMs) {
        try {
          fs.unlinkSync(file.path);
          console.log(`🧹 Törölve: ${file.path}`);
        } catch (err) {
          console.warn(`⚠️ Nem sikerült törölni: ${file.path}`, err);
        }
      }
    }
  }
}

module.exports = router;