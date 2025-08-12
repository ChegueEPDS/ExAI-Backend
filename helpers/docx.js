const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } = require("docx");

/**
 * 📄 OCR szöveg formázása és DOCX fájl generálása
 * A formázás ATEX vagy IECEx tanúsítvány típusától függően változik.
 * @param {string} ocrText - Az OCR által felismert nyers szöveg
 * @param {string} certNo - A tanúsítvány száma (fájlnévhez)
 * @param {string} certType - A tanúsítvány típusa ("ATEX" vagy "IECEx")
 * @param {string|null} outputPath - Opcionális: a generált fájl elérési útja
 * @returns {string} - A generált DOCX fájl elérési útja
 */
async function generateDocxFile(ocrText, certNo, certType, outputPath = null) {
    try {
        console.log(`📄 OCR szöveg formázása... Típus: ${certType}`);

        // 🚀 1. Szöveg előkészítése és tisztítása
        let cleanedText = ocrText
        //    .replace(/\n{2,}/g, '\n') // Többszörös üres sorok eltávolítása
        //    .replace(/\s{2,}/g, ' ')  // Extra szóközök eltávolítása
        //    .trim();

        // 🚀 2. Sorok feldolgozása
        const lines = cleanedText.split("\n").map(line => line.trim()).filter(line => line.length > 0);

        let formattedParagraphs = [];
        let tableData = [];
        let specialConditions = [];

        // **ATEX tanúsítvány esetén címsorok azonosítása** ([3], (4) formátum)
        const atexHeadingRegex = /^(\(|\[)\d+(\)|\])\s*(.+?):\s*(.*)$/; 
        // Példa: "(3) EC-Type Examination Certificate Number: XYZ"

        // IECEx és ATEX kulcsszavak
        const keyLabels = {
            ATEX: ["EC-Type Examination Certificate Number", "Equipment", "Manufacturer", "Address"],
            IECEx: ["Certificate No.", "Status", "Date of Issue", "Applicant", "Manufacturer", "Equipment", "Ex Marking", "Protection"]
        };

        // Technikai adatokhoz kulcsszavak
        const technicalDataKeywords = ["Power", "Size", "Weight", "Temperature", "W", "°C", "Hz", "IP"];

        // 🚀 3. Szöveg feldolgozása
        lines.forEach((line) => {
            if (certType === "ATEX") {
                // ATEX esetén ellenőrizzük, hogy a sor címsor-e ([3], (4) formátum)
                const atexMatch = line.match(atexHeadingRegex);
                if (atexMatch) {
                    formattedParagraphs.push(new Paragraph({
                        children: [
                            new TextRun({ text: `📌 ${atexMatch[3]}: `, bold: true, color: "0000FF" }), // **Félkövér és kék címsor**
                            new TextRun({ text: atexMatch[4] || "" }) // Cím értéke normál szövegként
                        ],
                        spacing: { after: 200 }
                    }));
                    return;
                }
            }

            // IECEx esetén ellenőrizzük a címsorokat
            const [key, ...values] = line.split(":");
            const value = values.join(":").trim();

            if (keyLabels[certType] && keyLabels[certType].includes(key.trim())) {
                formattedParagraphs.push(new Paragraph({
                    children: [
                        new TextRun({ text: `${key}: `, bold: true }), // **Félkövér címsor**
                        new TextRun({ text: value })
                    ],
                    spacing: { after: 200 }
                }));
            } else if (technicalDataKeywords.some(keyword => line.includes(keyword))) {
                // Technikai adatok táblázathoz gyűjtése
                const rowData = line.split(/\s{2,}/).map(item => item.trim());
                if (rowData.length > 1) {
                    tableData.push(rowData);
                }
            } else if (line.toLowerCase().includes("special conditions")) {
                // **"Special Conditions" kiemelése, de a helyén marad**
                specialConditions.push(new Paragraph({
                    children: [new TextRun({ text: `⚠️ ${line}`, bold: true, color: "FF0000" })],
                    spacing: { after: 150 }
                }));
                formattedParagraphs.push(new Paragraph({
                    children: [new TextRun({ text: line, bold: true, color: "FF0000" })],
                    spacing: { after: 150 }
                }));
            } else {
                // **Normál bekezdés**
                formattedParagraphs.push(new Paragraph({
                    children: [new TextRun(line)],
                    spacing: { after: 100 }
                }));
            }
        });

        // 🚀 4. Technikai adatok táblázatba foglalása (ha van)
        let table = null;
        if (tableData.length > 0) {
            const tableRows = tableData.map(row => new TableRow({
                children: row.map(cellText => new TableCell({
                    width: { size: 30, type: WidthType.PERCENTAGE },
                    children: [new Paragraph(cellText)]
                }))
            }));

            table = new Table({
                rows: [
                    new TableRow({
                        children: tableData[0].map(header => new TableCell({
                            width: { size: 30, type: WidthType.PERCENTAGE },
                            children: [new Paragraph({ children: [new TextRun({ text: header, bold: true })] })]
                        }))
                    }),
                    ...tableRows.slice(1)
                ]
            });
        }

        // 🚀 5. DOCX dokumentum létrehozása
        const doc = new Document({
            sections: [
                {
                    properties: {},
                    children: [
                        new Paragraph({
                            children: [new TextRun({ text: `Certificate: ${certNo} (${certType})`, bold: true, size: 32 })],
                            spacing: { after: 300 }
                        }),
                        ...(table ? [table] : []), // Ha van táblázat, adjuk hozzá
                        ...formattedParagraphs
                    ]
                }
            ]
        });

        // 📄 Fájl mentése
        const docxFilePath = outputPath || path.join(__dirname, `../uploads/${certNo}_${certType}_extracted.docx`);
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(docxFilePath, buffer);

        console.log(`✅ DOCX fájl sikeresen generálva: ${docxFilePath}`);
        return docxFilePath;
    } catch (error) {
        console.error("❌ Hiba a DOCX generálása során:", error);
        throw error;
    }
}

module.exports = { generateDocxFile };