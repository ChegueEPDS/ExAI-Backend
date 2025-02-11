require("dotenv").config();
const multer = require("multer");
const xlsx = require("xlsx");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

// Load environment variables
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

// Ensure upload directory exists
const uploadPath = path.join(__dirname, "../uploads/");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(xlsx)$/)) {
      return cb(new Error("Csak .xlsx fájlokat lehet feltölteni!"));
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
}).array("files", 2);

// Function to get column name from letter
function getColumnName(sheet, columnLetter) {
  const range = xlsx.utils.decode_range(sheet["!ref"]);
  const colIndex = xlsx.utils.decode_col(columnLetter);
  const firstRow = range.s.r;

  for (let c = 0; c <= range.e.c; c++) {
    const cellAddress = xlsx.utils.encode_cell({ r: firstRow, c: c });
    if (sheet[cellAddress] && c === colIndex) {
      return sheet[cellAddress].v;
    }
  }
  return null;
}

// Function to compare Excel files
function compareExcelFiles(file1, file2, keyColumnLetter) {
    const workbook1 = xlsx.readFile(file1);
    const workbook2 = xlsx.readFile(file2);
  
    const sheet1 = workbook1.Sheets[workbook1.SheetNames[0]];
    const sheet2 = workbook2.Sheets[workbook2.SheetNames[0]];
  
    // Get column name from the letter
    const keyColumn = getColumnName(sheet1, keyColumnLetter);
    if (!keyColumn) throw new Error("Invalid column letter for identifier.");
  
    const data1 = xlsx.utils.sheet_to_json(sheet1, { defval: "" });
    const data2 = xlsx.utils.sheet_to_json(sheet2, { defval: "" });
  
    let resultForExcel = [];  // Ez kerül az Excel fájlba (minden adattal)
    let changesForFrontend = [];  // Ez kerül vissza a frontendnek (csak ID + változások)
  
    // Convert data into a key-value mapping for easier comparison
    let oldDataMap = new Map(data1.map((row) => [row[keyColumn], row]));
    let newDataMap = new Map(data2.map((row) => [row[keyColumn], row]));
  
    let allKeys = new Set([...oldDataMap.keys(), ...newDataMap.keys()]);
  
    allKeys.forEach((key) => {
      const oldRow = oldDataMap.get(key) || null;
      const newRow = newDataMap.get(key) || null;
  
      if (!oldRow) {
        // Új sor: minden adat bekerül az Excelbe, de a frontendre csak az ID
        newRow._status = "new";
        resultForExcel.push(newRow);
        changesForFrontend.push({ [keyColumn]: key, _status: "new" });
      } else if (!newRow) {
        // Törölt sor: minden adat bekerül az Excelbe, de a frontendre csak az ID
        oldRow._status = "deleted";
        resultForExcel.push(oldRow);
        changesForFrontend.push({ [keyColumn]: key, _status: "deleted" });
      } else {
        // Módosított sor: teljes sor bekerül az Excelbe, de a frontendre csak ID + változások
        let modifiedRow = { ...newRow };
        let modifiedRowForFrontend = { [keyColumn]: key };
        let modified = false;
  
        Object.keys(newRow).forEach((col) => {
          if (col !== keyColumn && oldRow[col] !== newRow[col]) {
            modifiedRow[col] = `${newRow[col]} (régi: ${oldRow[col]})`;
            modifiedRowForFrontend[col] = `${newRow[col]} (régi: ${oldRow[col]})`;
            modified = true;
          }
        });
  
        if (modified) {
          resultForExcel.push(modifiedRow);
          changesForFrontend.push(modifiedRowForFrontend);
        } else {
          resultForExcel.push(newRow); // Ha nincs változás, akkor csak simán beírjuk
        }
      }
    });
  
    return { resultForExcel, changesForFrontend };
  }

// Function to create a comparison Excel file
async function createComparisonExcel(data, outputPath) {
    if (!data || !Array.isArray(data) || data.length === 0) {
      console.warn("⚠️  Az összehasonlítási adatok üresek vagy hibásak.");
      return;
    }
  
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Comparison");
  
    // Színezési szabályok
    const yellowFill = { type: "pattern", pattern: "solid", fgColor: { argb: "00AB60" } }; // Új sorok
    const redFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7070" } }; // Törölt sorok
    const orangeFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FDE471" } }; // Módosított cellák
    const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "D3D3D3" } }; // Fejléc háttér (halvány szürke)
    const headerFont = { bold: true }; // Fejléc betűtípus (félkövér)
  
    // Oszlopok beállítása (a `_status` oszlopot kizárjuk)
    const columns = Object.keys(data[0]).filter((col) => col !== "_status");
    worksheet.columns = columns.map((col) => ({ header: col, key: col, width: 20 }));

     // Fejléc formázása (félkövér betű + szürke háttér)
     worksheet.getRow(1).eachCell((cell) => {
        cell.fill = headerFill;
        cell.font = headerFont;
    });
  
    // Sorok beillesztése
    data.forEach((row) => {
      const newRow = worksheet.addRow(row);
  
      if (row._status === "new") {
        newRow.eachCell((cell) => cell.fill = yellowFill); // Új sorok kiemelése
      } else if (row._status === "deleted") {
        newRow.eachCell((cell) => cell.fill = redFill); // Törölt sorok kiemelése
      } else {
        // Módosított cellák kezelése
        newRow.eachCell((cell, colNumber) => {
          const colKey = worksheet.columns[colNumber - 1].key; // Oszlopnév lekérése
          if (row[colKey] && String(row[colKey]).includes("(régi:")) {
            // Szétválasztjuk az új és régi értéket
            const newValue = row[colKey].split(" (régi: ")[0];
            const oldValue = row[colKey].match(/\(régi: (.*)\)/)?.[1];
  
            if (oldValue) {
              // Csak az új értéket hagyjuk a cellában
              cell.value = newValue;
              cell.fill = orangeFill; // Színezés
  
              // Megjegyzés (régi érték megjelenítése)
              cell.note = `Régi érték: ${oldValue}`;
            }
          }
        });
      }
    });
  
    try {
      await workbook.xlsx.writeFile(outputPath);
      console.log(`📄 Excel fájl sikeresen létrehozva: ${outputPath}`);
    } catch (error) {
      console.error("❌ Hiba történt az Excel fájl mentése közben:", error);
    }
  }

// API endpoint to handle Excel comparison
exports.compareExcel = async (req, res) => {
    upload(req, res, async (err) => {
      if (err) {
        return res.status(500).json({ error: `Fájlfeltöltési hiba: ${err.message}` });
      }
  
      if (!req.files || req.files.length !== 2 || !req.body.columnLetter) {
        return res.status(400).json({ error: "Kérlek tölts fel két fájlt és adj meg egy oszlop betűjelét!" });
      }
  
      const file1 = req.files[0].path;
      const file2 = req.files[1].path;
      const columnLetter = req.body.columnLetter.toUpperCase();
  
      try {
        // 📌 1️⃣ Excel összehasonlítás végrehajtása
        const { resultForExcel, changesForFrontend } = compareExcelFiles(file1, file2, columnLetter);
  
        // 📌 2️⃣ Az összehasonlítás eredményének OpenAI API-hoz küldése
        let aiReply = "";
        if (changesForFrontend.length > 0) {
          const promptText = `
            Itt van egy Excel fájl összehasonlításának eredménye:
            ${JSON.stringify(changesForFrontend.slice(0, 10), null, 2)}
            
             Kérlek, elemezd és adj egy rövid szöveges összefoglalót HTML formátumban a változásokról. Ne használj <ul>, <li> vagy más listaelemeket, csak sima bekezdéseket (<p>), és fogalmazz természetesen, mintha egy ember röviden összefoglalná szóban.`;
  
          const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Excel fájlok összehasonlítása rövid ismertetéshez. Csak <p> tageket használj, ne használj listákat, és fogalmazz természetesen." },
                       { role: "user", content: promptText }],
            max_tokens: 300
          });
  
          aiReply = aiResponse.choices[0].message.content;
        }
  
        // 📌 3️⃣ Az összehasonlítás eredményének Excel fájlba mentése (TELJES adatokkal)
        const outputPath = path.join(uploadPath, "comparison_result.xlsx");
        await createComparisonExcel(resultForExcel, outputPath);
  
        fs.unlinkSync(file1);
        fs.unlinkSync(file2);
  
        // 📌 4️⃣ Eredmények visszaküldése a frontendnek (CSAK AZ ID + VÁLTOZOTT MEZŐK)
        res.json({
            changes: changesForFrontend.map(change => JSON.stringify(change)),  // 📌 Minden objektumot JSON stringgé alakítunk
            fileUrl: `${BASE_URL}/uploads/comparison_result.xlsx`,
            aiReply
        });
  
      } catch (error) {
        console.error("Hiba az összehasonlítás során:", error);
        res.status(500).json({ error: "Hiba történt az összehasonlítás során." });
      }
    });
  };