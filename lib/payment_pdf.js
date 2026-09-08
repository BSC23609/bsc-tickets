// Consolidated monthly payment report as a PDF (for Accounts). Used by staff OT and Labour.
// opts: { title, subtitle, approved, sections:[{ name, total, cols:[{label,align,width}], rows:[[..]] }], grandTotal }
const PDFDocument = require('pdfkit');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONTB = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const INK = '#112532', GRAY = '#8A97A3', LINE = '#D8E0E8', BLUE = '#0A4566', GREEN = '#059669', MIST = '#F1F5F9';
const rupee = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');

function buildPaymentReportPDF(opts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    doc.registerFont('Body', FONT); doc.registerFont('BodyBold', FONTB); doc.font('Body');
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const W = doc.page.width, M = 44, tableW = W - 2 * M;

    try { doc.image(GROUP, M, 30, { width: 92 }); } catch (e) { /* logo optional */ }
    doc.fillColor(BLUE).font('BodyBold').fontSize(18).text(opts.title, 0, 50, { align: 'center', width: W });
    if (opts.subtitle) doc.fillColor(GRAY).font('Body').fontSize(9).text(opts.subtitle, 0, 74, { align: 'center', width: W });
    if (opts.approved) {
      const bw = 92, bx = W - M - bw, by = 34;
      doc.roundedRect(bx, by, bw, 22, 11).fill(GREEN);
      doc.fillColor('#ffffff').font('BodyBold').fontSize(10).text('APPROVED', bx, by + 6, { width: bw, align: 'center' });
    }
    doc.moveTo(M, 98).lineTo(W - M, 98).lineWidth(2).strokeColor(BLUE).stroke();

    let y = 116;
    const drawHeadRow = (cols, xs) => {
      doc.fillColor(GRAY).font('BodyBold').fontSize(8);
      cols.forEach((c, ci) => doc.text(String(c.label).toUpperCase(), xs[ci], y, { width: c.width * tableW - 6, align: c.align || 'left' }));
      y += 14; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(LINE).stroke(); y += 5;
    };
    for (const sec of opts.sections) {
      if (y > 740) { doc.addPage(); y = 50; }
      doc.fillColor(BLUE).font('BodyBold').fontSize(12).text(`${sec.name}   (${rupee(sec.total)})`, M, y); y += 20;
      const cols = sec.cols; let x = M; const xs = cols.map(c => { const cx = x; x += c.width * tableW; return cx; });
      drawHeadRow(cols, xs);
      doc.font('Body').fontSize(10);
      if (!sec.rows.length) { doc.fillColor(GRAY).text('No entries.', M, y); y += 16; }
      for (const row of sec.rows) {
        if (y > 780) { doc.addPage(); y = 50; drawHeadRow(cols, xs); doc.font('Body').fontSize(10); }
        cols.forEach((c, ci) => doc.fillColor(INK).text(String(row[ci] == null ? '' : row[ci]), xs[ci], y, { width: c.width * tableW - 6, align: c.align || 'left' }));
        y += 15; doc.moveTo(M, y - 3).lineTo(W - M, y - 3).lineWidth(0.5).strokeColor('#EEF2F6').stroke();
      }
      y += 12;
    }
    if (y > 770) { doc.addPage(); y = 50; }
    doc.roundedRect(M, y, tableW, 30, 6).fill(MIST);
    doc.fillColor(INK).font('BodyBold').fontSize(13).text('Grand total', M + 12, y + 8);
    doc.fillColor(BLUE).font('BodyBold').fontSize(14).text(rupee(opts.grandTotal), M, y + 7, { width: tableW - 12, align: 'right' });
    doc.end();
  });
}

module.exports = { buildPaymentReportPDF };
