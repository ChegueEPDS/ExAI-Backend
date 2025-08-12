function extractValue(text, regex) {
  const match = text.match(regex);
  return match ? match[1]?.trim() : null;
}

function processOcrText(ocrText, certType = 'ATEX') {
  let regexes;

  if (certType === 'IECEx') {
    regexes = {
      certNo: extractValue(ocrText, /\b(IECEx\s+[A-Z]{2,4}\s+\d{2}\.\d{4,5}[UX]?)\b/i),
      status: extractValue(ocrText, /(?:Status:)\s*([\s\S]+?)(?=\n(?:Date of issue:|Issue No:|\n[A-Z]+\s[A-Z]+))/i)?.replace(/\n/g, " "),
      issueDate: extractValue(ocrText, /(?:Date of Issue:)\s*([\s\S]+?)(?=\n(?:Applicant:|\n[A-Z]+\s[A-Z]+))/i)?.replace(/\n/g, " "),
      applicant: extractValue(ocrText, /(?:Applicant:)\s*([\s\S]+?)(?=\n(?:Equipment:|Ex Component:|\n[A-Z]+\s[A-Z]+))/i)?.replace(/\n/g, " "),
      manufacturer: extractValue(ocrText, /(?:Manufacturer:|Manufactured by)\s*([^\n\r]+)/),
      equipment: extractValue(ocrText, /(?:Equipment:|Product:|Device:|Ex Component:)\s*([\s\S]+?)(?=\nThis component|Type of Protection:|Marking:|\n[A-Z]+\s[A-Z]+)/i),
      exmarking: extractValue(ocrText, /(?:Ex marking:|Marking:)[\s]*([\s\S]+?)(?=\n(?:Approved for issue|Certificate issued by|TÜV|On behalf of|\n[A-Z]+\s[A-Z]+))/i)?.replace(/\n/g, " "),
      protection: extractValue(ocrText, /Type of Protection:\s*([^\n]*?)(?=\s*Marking:|\n)/i),
      specCondition: extractValue(ocrText, /(?:SPECIFIC CONDITIONS OF USE:.*?|SCHEDULE OF LIMITATIONS:|Special Conditions of Use:?|Special conditions for safe use:?)[\s:]*([\s\S]+?)(?=\n(?:Annex:|Attachment to Certificate|TEST & ASSESSMENT REPORTS|This certificate|DETAILS OF CERTIFICATE CHANGES|IECEx|On behalf of|\n[A-Z]+\s[A-Z]+))/i),
      description: extractValue(ocrText, /(?:EQUIPMENT:.*?are as follows:|Ex Component\(s\) covered.*?described below:)\s*([\s\S]+?)(?=\n(?:SPECIFIC CONDITION OF USE:|SCHEDULE OF LIMITATIONS|Annex:|Attachment to Certificate|DETAILS OF CERTIFICATE CHANGES|IECEx|\n[A-Z]{3,}|\n[A-Z]+\s[A-Z]+))/i)
    };
  } else {
    regexes = {
      certNo:
        extractValue(ocrText, /Certificate(?: number| No\.?| N°)?:?\s*\n*([A-Za-z0-9\-\/\s]+IECEx\s+[A-Za-z0-9\-\/]+)/i) ||
        extractValue(ocrText, /(?:EC[-\s]Type Examination Certificate Number|EU[-\s]Type Examination Certificate number|Certificate(?: number| No\.?| N°)?)\s*\n*(?:Ex\s*\n*)?([A-Za-z0-9\-\/\s]+ATEX[^\n\r]+)/i) ||
        extractValue(ocrText, /\b([A-Za-z0-9\-\/]+)\s+ATEX\s+([A-Za-z0-9\-\/]+(?:\s*[XU])?)\b/i) ||
        extractValue(ocrText, /\b([A-Za-z0-9\-\/]+)\s+IECEX\s+([A-Za-z0-9\-\/]+(?:\s*[XU])?)\b/i) ||
        extractValue(ocrText, /\b(TÜV\s*[A-Za-z]{2,4}\s*\d{2}\s*ATEX\s*\d{3,5}\s*[XU]?)\b/i) ||
        '-',

      manufacturer: extractValue(ocrText, /(?:Manufacturer:|Manufactured by)\s*([^\n\r]+)/) || "-",

      equipment: extractValue(ocrText, /(?:Equipment or Protective System:|Equipment:|Product:)\s*([^\n\r]+)/) || "-",

      exmarking: (
        extractValue(
          ocrText,
          /(?:\[12\]|\(12\)|The marking of (?:the )?(?:equipment|product|protective system) shall include the following)[:\-\s]*([\s\S]+?)(?=\n\[\d+\]|\n[A-Z]{3,}|This certificate|TÜV|On behalf of)/i
        ) || ""
      )
        .replace(/\nSUL\nEx\n/, 'Ex\n')
        .replace(/@/, 'Ex')
        .replace(/℃/gi, "°C")
        .split(/[\n\s]+/)
        .map(line => line.trim())
        .filter(line => /(?:Ex|EEx|II|I|IP|T\d|D\sT\d+°C)/.test(line))
        .join(" ")
        .trim() || "-",

      specCondition: extractValue(
        ocrText,
        /(?:Special conditions for safe use|Specific condition of use|Special Conditions of Use|Special Conditions)[\s:]*([\s\S]+?)(?=\n\[\d+\]|\n[A-Z]{4,}|\nThis certificate|\nTÜV|\nOn behalf of|\n[A-Z]+\s[A-Z]+)/
      ) || "-",

      issueDate: extractValue(
        ocrText,
        /(?:Issue\s*date\s*[:.\s]*|Issued\s*on\s*)\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{2}[-/]\d{2}[-/]\d{4})/i
      ) || "-"
    };
  }

  return regexes;
}

module.exports = { processOcrText };