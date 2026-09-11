// Per-employee consolidated monthly payment report: a breakdown cover page followed by each
// individual claim/OT report merged into one PDF.
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONTB = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const money = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');

// Breakdown cover page (page 1 of the employee's consolidated report).
function buildCoverPdf({ empName, empNo, monthLabel, breakdown, total }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    doc.registerFont('B', FONT); doc.registerFont('BB', FONTB); doc.font('B');
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const W = doc.page.width, M = 48;
    try { doc.image(GROUP, M, 36, { width: 108 }); } catch (e) { /* logo optional */ }
    doc.fillColor('#0A4566').font('BB').fontSize(20).text('Payment Summary', 0, 60, { align: 'center', width: W });
    doc.fillColor('#112532').font('BB').fontSize(16).text(empName, 0, 100, { align: 'center', width: W });
    doc.fillColor('#0A4566').font('BB').fontSize(12).text(`Emp code: ${empNo || '—'}`, 0, 122, { align: 'center', width: W });
    doc.fillColor('#8A97A3').font('B').fontSize(11).text(monthLabel, 0, 140, { align: 'center', width: W });
    doc.moveTo(M, 166).lineTo(W - M, 166).lineWidth(2).strokeColor('#0A4566').stroke();
    let y = 196;
    doc.fillColor('#8A97A3').font('BB').fontSize(9);
    doc.text('PAYMENT TYPE', M, y); doc.text('AMOUNT', M, y, { width: W - 2 * M, align: 'right' }); y += 18;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor('#D8E0E8').stroke(); y += 10;
    doc.font('B').fontSize(13).fillColor('#112532');
    breakdown.forEach(b => {
      doc.fillColor('#112532').text(b.label, M, y);
      doc.text(money(b.amount), M, y, { width: W - 2 * M, align: 'right' });
      y += 26; doc.moveTo(M, y - 8).lineTo(W - M, y - 8).lineWidth(0.5).strokeColor('#EEF2F6').stroke();
    });
    y += 12;
    doc.roundedRect(M, y, W - 2 * M, 42, 8).fill('#0A4566');
    doc.fillColor('#ffffff').font('BB').fontSize(15).text('TOTAL', M + 16, y + 13);
    doc.fillColor('#ffffff').font('BB').fontSize(18).text(money(total), M, y + 11, { width: W - M - 16, align: 'right' });
    doc.fillColor('#94a3b8').font('B').fontSize(9).text('Individual reports follow in the order above.', M, y + 60);
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
