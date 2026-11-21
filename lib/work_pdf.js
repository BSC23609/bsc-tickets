// Approval for Work (Sunday) slip — A4 portrait, pdfkit. Group logo left, BSC logo right,
// work details, employee + labour teams, and the two approval stamps (1st approval + HR verification).
const PDFDocument = require('pdfkit');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const BSC   = path.join(__dirname, '..', 'public', 'img', 'bsc-logo.png');

const INK = '#112532', GRAY = '#8A97A3', LINE = '#D8E0E8', GREEN = '#1E9E5A', SOFT = '#F4F7FA';

function fmtTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
}

// d = { ref_no, place_label, date, time, nature, team_emp[], team_labour[],
//       raised_by, approve_by, approve_at, check_by, check_at }
function buildWorkSlipPDF(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const W = doc.page.width, M = 48;
    const fullW = W - 2 * M;

    // ---- header ----
    try { doc.image(GROUP, M, 36, { width: 110 }); } catch (e) {}
    try { const bW = 120; doc.image(BSC, W - M - bW, 38, { width: bW }); } catch (e) {}

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20)
       .text('APPROVAL FOR WORK', 0, 92, { align: 'center', width: W, characterSpacing: 2 });
    doc.fillColor(GRAY).font('Helvetica').fontSize(10)
       .text('Sunday / holiday work authorization', 0, 118, { align: 'center', width: W });

    let y = 150;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 16;

    const field = (label, val, x, yy, w) => {
      doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(label, x, yy, { characterSpacing: 1 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(val || '—', x, yy + 12, { width: w });
    };
    const colR = M + fullW / 2 + 10, halfW = fullW / 2 - 10;
    field('REFERENCE NO', d.ref_no, M, y, halfW);
    field('PLACE', d.place_label, colR, y, halfW);
    y += 46;
    field('WORK DATE', d.date, M, y, halfW);
    field('TIME', d.time || '—', colR, y, halfW);
    y += 46;
    field('NATURE OF WORK', d.nature, M, y, fullW);
    y += 20 + Math.max(12, doc.heightOfString(d.nature || '—', { width: fullW, fontSize: 12 }));

    // ---- team tables ----
    const drawTeam = (title, rows, startY) => {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(title, M, startY);
      let ty = startY + 18;
      // header row
      doc.rect(M, ty, fullW, 20).fillColor(SOFT).fill();
      doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(8);
      doc.text('#', M + 8, ty + 6, { width: 20 });
      doc.text('NAME', M + 34, ty + 6, { width: fullW * 0.5 });
      doc.text('DESIGNATION', M + 34 + fullW * 0.5, ty + 6, { width: fullW * 0.45 });
      ty += 20;
      doc.font('Helvetica').fontSize(10).fillColor(INK);
      (rows || []).forEach((r, i) => {
        doc.fillColor(i % 2 ? '#FFFFFF' : '#FBFCFE').rect(M, ty, fullW, 18).fill();
        doc.fillColor(INK).font('Helvetica').fontSize(10);
        doc.text(String(i + 1), M + 8, ty + 4, { width: 20 });
        doc.text(r.name || '—', M + 34, ty + 4, { width: fullW * 0.5 - 6, ellipsis: true });
        doc.text(r.designation || '—', M + 34 + fullW * 0.5, ty + 4, { width: fullW * 0.45, ellipsis: true });
        ty += 18;
      });
      if (!rows || !rows.length) {
        doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(9).text('None', M + 8, ty + 4); ty += 18;
      }
      return ty + 14;
    };
    y = drawTeam('TEAM — EMPLOYEES', d.team_emp, y + 6);
    y = drawTeam('TEAM — LABOUR', d.team_labour, y);

    // ---- approvals ----
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 14;
    const stamp = (label, by, at, x) => {
      const w = fullW / 2 - 10;
      doc.roundedRect(x, y, w, 56, 8).fillColor('#E7F6EE').fill();
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text(label, x + 14, y + 10, { characterSpacing: 1 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(by || '—', x + 14, y + 24, { width: w - 28, ellipsis: true });
      doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(fmtTs(at), x + 14, y + 42, { width: w - 28 });
    };
    stamp('1ST APPROVAL', d.approve_by, d.approve_at, M);
    stamp('HR VERIFICATION', d.check_by, d.check_at, colR);
    y += 70;

    doc.fillColor(GRAY).font('Helvetica').fontSize(8)
       .text(`Raised by ${d.raised_by || '—'}  ·  Status: APPROVED  ·  This is a system-generated slip.`, M, y, { width: fullW });

    doc.end();
  });
}

module.exports = buildWorkSlipPDF;
