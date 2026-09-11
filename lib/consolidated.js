// Per-employee consolidated monthly payment report: a breakdown cover page followed by each
// individual claim/OT report merged into one PDF.
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const BSC = path.join(__dirname, '..', 'public', 'img', 'bsc-logo.png');
const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONTB = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const money = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');

// Breakdown cover page (page 1 of the employee's consolidated report).
function buildCoverPdf({ empName, empNo, monthLabel, breakdown, total }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    doc.registerFont('B', FONT); doc.registerFont('BB', FONTB); doc.font('B');
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const W = doc.page.width, M = 48, tableW = W - 2 * M;

    // BSC (company) logo left, Group logo right — same width, a touch smaller.
    const LOGO_W = 82;
    try { doc.image(BSC, M, 34, { width: LOGO_W }); } catch (e) { /* optional */ }
    try { doc.image(GROUP, W - M - LOGO_W, 34, { width: LOGO_W }); } catch (e) { /* optional */ }

    doc.fillColor('#0A4566').font('BB').fontSize(19).text('Payment Summary', 0, 92, { align: 'center', width: W });
    doc.fillColor('#112532').font('BB').fontSize(16).text(empName, 0, 122, { align: 'center', width: W });
    doc.fillColor('#0A4566').font('BB').fontSize(12).text(`Emp code: ${empNo || '\u2014'}`, 0, 144, { align: 'center', width: W });
    doc.fillColor('#8A97A3').font('B').fontSize(11).text(monthLabel, 0, 162, { align: 'center', width: W });
    doc.moveTo(M, 188).lineTo(W - M, 188).lineWidth(2).strokeColor('#0A4566').stroke();

    // 3-column table: PAYMENT TYPE | APPROVED BY (name + date/time) | AMOUNT
    const cType = M, wType = 0.40 * tableW;
    const cBy = M + 0.40 * tableW, wBy = 0.36 * tableW;
    let y = 214;
    doc.fillColor('#8A97A3').font('BB').fontSize(9);
    doc.text('PAYMENT TYPE', cType, y, { width: wType });
    doc.text('APPROVED BY', cBy, y, { width: wBy });
    doc.text('AMOUNT', M, y, { width: tableW, align: 'right' });
    y += 16; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor('#D8E0E8').stroke(); y += 8;

    breakdown.forEach(b => {
      doc.fillColor('#112532').font('B').fontSize(12).text(b.label, cType, y, { width: wType - 4 });
      doc.fillColor('#112532').font('B').fontSize(10).text(b.by || '\u2014', cBy, y, { width: wBy - 4 });
      if (b.at) doc.fillColor('#8A97A3').font('B').fontSize(8).text(b.at, cBy, y + 12, { width: wBy - 4 });
      doc.fillColor('#112532').font('B').fontSize(12).text(money(b.amount), M, y, { width: tableW, align: 'right' });
      y += (b.at ? 30 : 22); doc.moveTo(M, y - 8).lineTo(W - M, y - 8).lineWidth(0.5).strokeColor('#EEF2F6').stroke();
    });

    y += 12;
    doc.roundedRect(M, y, tableW, 42, 8).fill('#0A4566');
    doc.fillColor('#ffffff').font('BB').fontSize(15).text('TOTAL', M + 16, y + 13);
    // amount right-aligned INSIDE the bar (bar width - padding), not past it
    doc.fillColor('#ffffff').font('BB').fontSize(18).text(money(total), M, y + 12, { width: tableW - 16, align: 'right' });
    doc.fillColor('#94a3b8').font('B').fontSize(9).text('Individual reports follow in the order above.', M, y + 58);
    doc.end();
  });
}

// Merge an ordered list of PDF buffers into one PDF.
async function mergePdfs(buffers) {
  const out = await PDFLib.create();
  for (const buf of buffers) {
    if (!buf) continue;
    try {
      const src = await PDFLib.load(buf);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    } catch (e) { console.error('[consolidated merge] skipped a PDF:', e.message); }
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}

module.exports = { buildCoverPdf, mergePdfs, money };
