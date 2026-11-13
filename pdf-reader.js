/* Turns a text-based PDF statement into rows for the engine, using the vendored PDF.js.
   Columns are found from the header row's position, so no per-bank template is needed. */
(function (root) {
  'use strict';

  const E = root.BankEngine;
  const NUMERIC = new Set(['debit', 'credit', 'amount', 'balance']);
  const OUTPUT_KEYS = ['date', 'desc', 'debit', 'credit', 'amount', 'type', 'balance'];
  const OUTPUT_HEADER = ['Date', 'Narration', 'Debit', 'Credit', 'Amount', 'Type', 'Balance'];
  const MONEY_RE = /^(₦|NGN|N)?\s*[-(]?\s*(₦|NGN)?\s*\d[\d,]*(\.\d+)?\s*\)?-?\s*(DR|CR)?\.?$/i;
  const AMOUNT_RE = /\d\.\d{2}\b/;
  const MIN_AMOUNTS = 5; // Scans can still carry printed headers and footers, but not columns of amounts.
  const MAX_CONTINUATION_GAP = 2.2;
  const EDITING_TOOL_RE = /photoshop|illustrator|indesign|canva|ilovepdf|smallpdf|sejda|pdfescape|pdffiller|phantompdf|nitro|pdf-xchange|microsoft.*(word|excel)|libreoffice|openoffice|wps|skia\/pdf|print to pdf|quartz/i;

  class PdfReadError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  /* ---------- layout ---------- */

  function toLines(items) {
    const sorted = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x0 - b.x0);
    const lines = [];
    sorted.forEach((item) => {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.y - item.y) <= 0.4 * Math.max(line.h, item.h)) {
        line.items.push(item);
        line.h = Math.max(line.h, item.h);
      } else {
        lines.push({ y: item.y, h: item.h, items: [item] });
      }
    });
    lines.forEach((line) => line.items.sort((a, b) => a.x0 - b.x0));
    return lines;
  }

  function joinParts(items, height) {
    let text = '';
    let lastEnd = null;
    items.forEach((item) => {
      if (lastEnd !== null && item.x0 - lastEnd > 0.15 * height) text += ' ';
      text += item.str.trim();
      lastEnd = item.x1;
    });
    return text.trim();
  }

  function segments(line) {
    const out = [];
    line.items.forEach((item) => {
      const last = out[out.length - 1];
      if (last && item.x0 - last.x1 <= 0.6 * line.h) {
        last.parts.push(item);
        last.x1 = Math.max(last.x1, item.x1);
      } else {
        out.push({ parts: [item], x0: item.x0, x1: item.x1 });
      }
    });
    return out.map((s) => ({ text: joinParts(s.parts, line.h), x0: s.x0, x1: s.x1 }));
  }

  function mergeHeaderLines(upper, lower) {
    const cells = upper.map((c) => ({ ...c }));
    lower.forEach((cell) => {
      const match = cells.find((c) => cell.x0 < c.x1 + 2 && cell.x1 > c.x0 - 2);
      if (match) {
        match.text = `${match.text} ${cell.text}`;
        match.x0 = Math.min(match.x0, cell.x0);
        match.x1 = Math.max(match.x1, cell.x1);
      } else {
        cells.push({ ...cell });
      }
    });
    return cells.sort((a, b) => a.x0 - b.x0);
  }

  function toColumns(cells) {
    const map = E.mapColumns(cells.map((c) => c.text));
    if (!map) return null;
    const cols = cells.map((c) => ({ x0: c.x0, x1: c.x1, cx: (c.x0 + c.x1) / 2, key: null }));
    Object.entries(map).forEach(([key, index]) => { cols[index].key = key; });
    return cols;
  }

  function tryHeader(lines, i) {
    const line = lines[i];
    const raw = line.items.map((it) => ({ text: it.str.trim(), x0: it.x0, x1: it.x1 }));
    const single = toColumns(segments(line)) || toColumns(raw);
    if (single) return { cols: single, used: 1 };
    const next = lines[i + 1];
    if (next && line.y - next.y <= 2 * Math.max(line.h, next.h)) {
      const merged = toColumns(mergeHeaderLines(segments(line), segments(next)));
      if (merged) return { cols: merged, used: 2 };
    }
    return null;
  }

  function assignColumn(item, cols) {
    const text = item.str.trim();
    const cx = (item.x0 + item.x1) / 2;
    const numeric = cols.filter((c) => NUMERIC.has(c.key));
    const numStart = Math.min(...numeric.map((c) => c.x0));
    if ((MONEY_RE.test(text) || /^-+$/.test(text)) && cx >= numStart - 2) {
      let best = numeric[0];
      let bestDistance = Infinity;
      numeric.forEach((c) => {
        const distance = Math.min(Math.abs(item.x1 - c.x1), Math.abs(cx - c.cx), Math.abs(item.x0 - c.x0));
        if (distance < bestDistance) {
          best = c;
          bestDistance = distance;
        }
      });
      return best;
    }
    const width = item.x1 - item.x0;
    const under = cols.find((c) => cx >= c.x0 - 2 && cx <= c.x1 + 2 && width <= (c.x1 - c.x0) * 2.5);
    if (under) return under;
    let found = cols[0];
    cols.forEach((c) => {
      if (c.x0 <= item.x0 + 3) found = c;
    });
    return found;
  }

  function readLine(line, cols) {
    const byColumn = new Map();
    line.items.forEach((item) => {
      const col = assignColumn(item, cols);
      if (!byColumn.has(col)) byColumn.set(col, []);
      byColumn.get(col).push(item);
    });
    const row = {};
    byColumn.forEach((items, col) => {
      if (col.key) row[col.key] = joinParts(items, line.h);
    });
    return row;
  }

  function isDate(text) {
    return E.parseDate(text, 'DMY') !== null || E.parseDate(text, 'MDY') !== null;
  }

  function fitsNarration(line, cols) {
    const desc = cols.find((c) => c.key === 'desc');
    if (!desc) return false;
    const next = cols.filter((c) => c.x0 > desc.x0).sort((a, b) => a.x0 - b.x0)[0];
    return line.items.every((it) => it.x0 >= desc.x0 - 3 && (!next || it.x0 < next.x0));
  }

  // pages: an array of text-item arrays, one per page.
  function buildRows(pages) {
    const rows = [OUTPUT_HEADER];
    const rowPages = [null];
    let cols = null;

    pages.forEach((items, pageIndex) => {
      const lines = toLines(items);
      let openRow = null;
      let lastY = null;
      for (let i = 0; i < lines.length; i++) {
        const header = tryHeader(lines, i);
        if (header) {
          cols = header.cols;
          i += header.used - 1;
          openRow = null;
          continue;
        }
        if (!cols) continue;

        const line = lines[i];
        const row = readLine(line, cols);
        const hasNumbers = OUTPUT_KEYS.some((k) => NUMERIC.has(k) && row[k]);
        if (isDate(row.date) || hasNumbers) {
          const cells = OUTPUT_KEYS.map((k) => row[k] || '');
          rows.push(cells);
          rowPages.push(pageIndex + 1);
          openRow = isDate(row.date) ? cells : null;
          lastY = line.y;
          continue;
        }
        const closeEnough = lastY !== null && lastY - line.y <= MAX_CONTINUATION_GAP * line.h;
        if (openRow && closeEnough && fitsNarration(line, cols) && !/^page\s+\d+/i.test(line.items[0].str.trim())) {
          openRow[1] = `${openRow[1]} ${joinParts(line.items, line.h)}`.trim();
          lastY = line.y;
        } else {
          openRow = null;
        }
      }
    });

    return { rows, pages: rowPages, foundHeader: cols !== null };
  }

  /* ---------- document checks ---------- */

  function countEof(bytes) {
    const marker = [37, 37, 69, 79, 70]; // %%EOF
    let count = 0;
    for (let i = 0; i <= bytes.length - marker.length; i++) {
      if (bytes[i] === marker[0] && marker.every((b, j) => bytes[i + j] === b)) count++;
    }
    return count;
  }

  function parsePdfDate(value) {
    const lib = root.pdfjsLib;
    return value && lib ? lib.PDFDateString.toDateObject(value) : null;
  }

  function documentWarnings(info, eofCount) {
    const warnings = [];
    const producer = info.Producer || '';
    const creator = info.Creator || '';
    const tool = EDITING_TOOL_RE.exec(`${producer} ${creator}`);
    if (tool) warnings.push(`The PDF was produced with a general-purpose tool (${tool[0]}), not usually a bank's statement system.`);
    const created = parsePdfDate(info.CreationDate);
    const modified = parsePdfDate(info.ModDate);
    if (created && modified && modified.getTime() - created.getTime() > 60000) {
      warnings.push(`The PDF was modified after it was created (${created.toISOString().slice(0, 10)} to ${modified.toISOString().slice(0, 10)}).`);
    }
    if (eofCount > (info.IsLinearized ? 2 : 1)) warnings.push(`The PDF contains ${eofCount} saved revisions, so it was changed after first being written.`);
    return warnings;
  }

  /* ---------- entry point ---------- */

  async function read(buffer, password) {
    const bytes = new Uint8Array(buffer);
    const eofCount = countEof(bytes);
    let doc;
    try {
      // Eval stays off because statements are untrusted input (CVE-2024-4367 mitigation).
      doc = await root.pdfjsLib.getDocument({ data: bytes, password, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        throw new PdfReadError(password ? 'wrong-password' : 'needs-password', password ? 'That password did not open the PDF.' : 'This PDF is password-protected.');
      }
      throw new PdfReadError('unreadable', 'This PDF could not be opened. It may be damaged.');
    }

    try {
      const pages = [];
      let amounts = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const items = content.items
          .filter((it) => it.str && Math.abs(it.transform[1]) < 0.01)
          .map((it) => ({ str: it.str, x0: it.transform[4], x1: it.transform[4] + it.width, y: it.transform[5], h: it.height || Math.abs(it.transform[3]) || 10 }));
        amounts += items.filter((it) => AMOUNT_RE.test(it.str)).length;
        pages.push(items);
      }
      if (amounts < MIN_AMOUNTS) {
        throw new PdfReadError('scanned', "No transaction amounts could be read from this PDF. It may be a scan or photo, which isn't supported yet, or it may not be a statement. Please ask for the bank's original PDF.");
      }
      const built = buildRows(pages);
      if (!built.foundHeader) {
        throw new PdfReadError('no-table', "The transaction table could not be found. This PDF's column headings may not be recognised yet.");
      }
      const { info } = await doc.getMetadata();
      return {
        rows: built.rows,
        pages: built.pages,
        source: 'pdf',
        warnings: documentWarnings(info || {}, eofCount),
        document: { pages: doc.numPages, producer: (info && info.Producer) || null, creator: (info && info.Creator) || null },
      };
    } finally {
      doc.destroy();
    }
  }

  root.BankPdf = { read, buildRows, toLines, documentWarnings, countEof, PdfReadError };
})(typeof window !== 'undefined' ? window : globalThis);
