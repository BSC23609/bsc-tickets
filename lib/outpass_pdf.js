// Outpass / Gatepass slip — A5 landscape (half of A4), rebuilt in pdfkit to match
// the approved reportlab design. Group logo left, BSC logo right, green approval band.
const PDFDocument = require('pdfkit');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const BSC   = path.join(__dirname, '..', 'public', 'img', 'bsc-logo.png');

const INK = '#112532', GRAY = '#8A97A3', LINE = '#D8E0E8', GREEN = '#1E9E5A';

// d = { type:'gatepass'|'outpass', on_duty, date, emp_code, name, designation,
//       purpose, out_time, in_time, ref_no, approver, approved_at }
function buildOutpassPDF(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 0 });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const W = doc.page.width, H = doc.page.height, M = 42;

    // ---- header: logos on either side ----
    doc.image(GROUP, M, 26, { width: 104 });
    const bW = 120;
    doc.image(BSC, W - M - bW, 28, { width: bW });

    // ---- title ----
    const title = d.type === 'gatepass' ? 'GATEPASS' : 'OUTPASS';
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(28)
       .text(title, 0, 74, { align: 'center', width: W, characterSpacing: 3 });

    // ---- divider ----
    const dy = 114;
    doc.moveTo(M, dy).lineTo(W - M, dy).lineWidth(1).strokeColor(LINE).stroke();

    // ---- reference + on-duty pill (below the divider, shared baseline) ----
    const ry = dy + 12;
    doc.fillColor(GRAY).font('Helvetica').fontSize(7.5).text('REFERENCE NO', M, ry, { characterSpacing: 1 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(d.ref_no, M, ry + 11);
    if (d.on_duty) {
      const pw = 80, ph = 20, px = W - M - pw, py = ry + 2;
      doc.roundedRect(px, py, pw, ph, 10).fillColor('#E7F6EE').fill();
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9)
         .text('ON DUTY', px, py + 6, { width: pw, align: 'center', characterSpacing: 1 });
    }

    // ---- detail fields ----
    const colL = M, colR = W / 2 + 8, halfW = (W / 2) - M - 8, fullW = W - 2 * M;
    const field = (label, val, x, yy, w) => {
      doc.fillColor(GRAY).font('Helvetica').fontSize(7.5).text(label, x, yy, { characterSpacing: 1 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
         .text(val || '—', x, yy + 12, { width: w, ellipsis: true });
    };

    let y = dy + 46;
    const rowH = 44;
    field('DATE', d.date, colL, y, halfW);
    field('EMPLOYEE CODE', d.emp_code, colR, y, halfW);
    y += rowH;
    field('NAME', d.name, colL, y, halfW);
    field('DESIGNATION', d.designation, colR, y, halfW);
    y += rowH;
    field('OUT-TIME', d.out_time, colL, y, halfW);
    if (d.type === 'gatepass') field('IN-TIME', d.in_time, colR, y, halfW);
    y += rowH;
    field('PURPOSE', d.purpose, colL, y, fullW);

    // ---- approval band ----
    const by = H - 60, bh = 38;
    doc.roundedRect(M, by, fullW, bh, 8).fillColor(GREEN).fill();
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
       .text('APPROVED', M + 18, by + 12, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(10).fillColor('#EAFBF1')
       .text(`Approved by ${d.approver}    ${d.approved_at}`, M, by + 14,
             { width: fullW - 18, align: 'right' });

    doc.end();
  });
}

module.exports = { buildOutpassPDF };
