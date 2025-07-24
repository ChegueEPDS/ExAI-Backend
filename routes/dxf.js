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
    } catch (e) {
      res.status(500).json({ error: 'Hibás JSON a Python szkriptből.' });
    }
  });
});

module.exports = router;