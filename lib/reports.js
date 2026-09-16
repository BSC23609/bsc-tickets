// Combined report: a summary table on page 1 (everyone), then each person's per-day detail in
// the same order. Used for the Overtime and Shearing consolidated reports.
const PDFDocument = require('pdfkit');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const LOGOS = { BSC: path.join(__dirname, '..', 'public', 'img', 'bsc-logo.png'), G2: path.join(__dirname, '..', 'public', 'img', 'g2-logo.png') };
const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONTB = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const money = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');
const INK = '#112532', GRAY = '#8A97A3', LINE = '#D8E0E8', BLUE = '#0A4566';

function pageHeader(doc, companyKey, title, subtitle) {
  const W = doc.page.width, M = 44, LW = 78;
  try { doc.image(LOGOS[companyKey] || LOGOS.BSC, M, 30, { width: LW }); } catch (e) {}
  try { doc.image(GROUP, W - M - LW, 30, { width: LW }); } catch (e) {}
  doc.fillColor(BLUE).font('BB').fontSize(17).text(title, 0, 80, { align: 'center', width: W });
  if (subtitle) doc.fillColor(GRAY).font('B').fontSize(9).text(subtitle, 0, 102, { align: 'center', width: W });
  doc.moveTo(M, 124).lineTo(W - M, 124).lineWidth(2).strokeColor(BLUE).stroke();
  return 142;
}

// cols: [{label,width(0..1),align}], rows: [[...]], totalRow: [...] (optional)
function drawTable(doc, y, cols, rows, totalRow) {
  const W = doc.page.width, M = 44, tableW = W - 2 * M;
  let x = M; const xs = cols.map(c => { const cx = x; x += c.width * tableW; return cx; });
  const head = () => {
    doc.fillColor(GRAY).font('BB').fontSize(8);
    cols.forEach((c, i) => doc.text(String(c.label).toUpperCase(), xs[i], y, { width: c.width * tableW - 6, align: c.align || 'left' }));
    y += 14; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(LINE).stroke(); y += 5;
  };
  head();
  doc.font('B').fontSize(10);
  if (!rows.length) { doc.fillColor(GRAY).text('No entries.', M, y); y += 16; }
  for (const r of rows) {
    if (y > 790) { doc.addPage(); y = 44; head(); doc.font('B').fontSize(10); }
    cols.forEach((c, i) => doc.fillColor(INK).text(r[i] == null ? '' : String(r[i]), xs[i], y, { width: c.width * tableW - 6, align: c.align || 'left' }));
    y += 15; doc.moveTo(M, y - 3).lineTo(W - M, y - 3).lineWidth(0.5).strokeColor('#EEF2F6').stroke();
  }
  if (totalRow) {
    y += 4; doc.roundedRect(M, y, tableW, 26, 5).fill('#F1F5F9');
    doc.fillColor(INK).font('BB').fontSize(11);
    cols.forEach((c, i) => { if (totalRow[i] != null && totalRow[i] !== '') doc.text(String(totalRow[i]), xs[i], y + 7, { width: c.width * tableW - 6, align: c.align || 'left' }); });
    y += 30;
  }
  return y;
}

// opts: { companyKey, title, subtitle, summary:{cols,rows,totalRow}, people:[{heading,sub,cols,rows,totalRow}] }
function buildCombinedReportPDF(opts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    doc.registerFont('B', FONT); doc.registerFont('BB', FONTB); doc.font('B');
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);

    let y = pageHeader(doc, opts.companyKey, opts.title, opts.subtitle);
    doc.fillColor(BLUE).font('BB').fontSize(12).text('Consolidated summary', 44, y); y += 20;
    drawTable(doc, y, opts.summary.cols, opts.summary.rows, opts.summary.totalRow);

    (opts.people || []).forEach(p => {
      doc.addPage();
      let py = pageHeader(doc, opts.companyKey, p.heading, p.sub);
      drawTable(doc, py, p.cols, p.rows, p.totalRow);
    });
    doc.end();
  });
}

module.exports = { buildCombinedReportPDF, money };
