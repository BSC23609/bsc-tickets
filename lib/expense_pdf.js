// Expense PDFs (pdfkit). Conveyance = one A4 page, no bills. Outstation/Misc
// (added later) reuse the header/table helpers and merge bills via pdf-lib.
const PDFDocument = require('pdfkit');
const path = require('path');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const BSC   = path.join(__dirname, '..', 'public', 'img', 'bsc-logo.png');
const FONT  = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');       // has the ₹ glyph (Helvetica does not)
const FONTB = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const INK = '#112532', GRAY = '#8A97A3', LINE = '#D8E0E8', GREEN = '#1E9E5A', MIST = '#F5F8FB';
const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Register the Unicode fonts on a doc and make Body the default. Must run before
// any text/header is drawn so the ₹ symbol renders instead of a fallback glyph.
function useFonts(doc) { doc.registerFont('Body', FONT); doc.registerFont('BodyBold', FONTB); doc.font('Body'); }

function header(doc, W, M, title, subtitle) {
  doc.image(GROUP, M, 30, { width: 96 });
  doc.image(BSC, W - M - 110, 32, { width: 110 });
  doc.fillColor(INK).font('BodyBold').fontSize(18)
     .text(title, 0, 86, { align: 'center', width: W, characterSpacing: 1 });
  if (subtitle) doc.fillColor(GRAY).font('Body').fontSize(9)
     .text(subtitle, 0, 108, { align: 'center', width: W });
  doc.moveTo(M, 126).lineTo(W - M, 126).lineWidth(2).strokeColor('#0E6AA6').stroke();
}

function kv(doc, x, y, k, v, w) {
  doc.fillColor(GRAY).font('Body').fontSize(7.5).text(k.toUpperCase(), x, y, { characterSpacing: 1 });
  doc.fillColor(INK).font('BodyBold').fontSize(10.5).text(v || '—', x, y + 11, { width: w });
}

// d = { ref_no, emp_name, emp_code, designation, category, period_label, vehicle_rates,
//       entries:[{date,from,to,vehicle_label,km,amount}], total, status,
//       approver, approved_at }
function buildConveyancePDF(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0 }); useFonts(doc);
    const bufs = []; doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const W = doc.page.width, M = 44;

    header(doc, W, M, 'LOCAL TRAVEL CONVEYANCE', `Reimbursement claim · ${d.period_label}`);

    // employee block
    let y = 142;
    const colW = (W - 2 * M) / 4;
    kv(doc, M, y, 'Name', d.emp_name, colW - 8);
    kv(doc, M + colW, y, 'Emp Code', d.emp_code, colW - 8);
    kv(doc, M + 2 * colW, y, 'Designation', d.designation, colW - 8);
    kv(doc, M + 3 * colW, y, 'Category', d.category, colW - 8);
    y += 36;
    kv(doc, M, y, 'Reference', d.ref_no, colW * 2);
    kv(doc, M + 2 * colW, y, 'Period', d.period_label, colW - 8);
    kv(doc, M + 3 * colW, y, 'Rates', `Bike ${rupee(d.vehicle_rates.bike)}/km · Car ${rupee(d.vehicle_rates.car)}/km`.replace(/INR /g, '₹'), colW * 1.2);
    y += 42;

    // table
    const cols = [
      { t: '#', w: 20, a: 'left' }, { t: 'Date', w: 54, a: 'left' },
      { t: 'From', w: 76, a: 'left' }, { t: 'To', w: 76, a: 'left' },
      { t: 'Purpose', w: 90, a: 'left' }, { t: 'Vehicle', w: 46, a: 'left' },
      { t: 'KM', w: 30, a: 'right' }, { t: 'Amount', w: 62, a: 'right' },
      { t: 'Flag', w: 40, a: 'center' },
    ];
    const RED = '#C0392B', REDBG = '#FDECEC';
    const tableX = M, tableW = W - 2 * M;
    const amtX = tableX + cols.slice(0, 7).reduce((s, c) => s + c.w, 0); // x where Amount col starts
    // header row
    doc.rect(tableX, y, tableW, 22).fillColor(INK).fill();
    let cx = tableX + 8;
    doc.fillColor('#fff').font('BodyBold').fontSize(8);
    for (const c of cols) { doc.text(c.t.toUpperCase(), cx, y + 7, { width: c.w - 8, align: c.a }); cx += c.w; }
    y += 22;
    // body
    let anyLate = false;
    (d.entries || []).forEach((e, i) => {
      if (e.late) { anyLate = true; doc.rect(tableX, y, tableW, 20).fillColor(REDBG).fill(); }
      else if (i % 2) { doc.rect(tableX, y, tableW, 20).fillColor(MIST).fill(); }
      cx = tableX + 8;
      const vals = [String(i + 1), e.date, e.from || '-', e.to || '-', e.purpose || '-', e.vehicle_label,
        String(e.km), rupee(e.amount).replace('INR ', '₹'), e.late ? 'LATE' : ''];
      cols.forEach((c, ci) => {
        if (c.t === 'Flag' && e.late) doc.fillColor(RED).font('BodyBold').fontSize(7.5);
        else doc.fillColor(INK).font('Body').fontSize(8.5);
        doc.text(vals[ci], cx, y + 6, { width: c.w - 8, align: c.a, ellipsis: true });
        cx += c.w;
      });
      y += 20;
    });
    // total row
    doc.rect(tableX, y, tableW, 24).fillColor('#EAF2F8').fill();
    doc.fillColor(INK).font('BodyBold').fontSize(11)
       .text('TOTAL', tableX + 8, y + 7, { width: amtX - tableX - 16 });
    doc.text(rupee(d.total).replace('INR ', '₹'), amtX, y + 7, { width: cols[7].w, align: 'right' });
    y += 30;

    // late footnote
    if (anyLate) {
      doc.font('Body').fontSize(8).fillColor(RED)
         .text(`\u26A0  Rows marked LATE were logged more than ${d.log_hours || 48} hours after the trip date and are treated as NOT APPROVED.`,
               M, y, { width: tableW });
      y += 22;
    }

    // status band
    const bandY = Math.max(y, doc.page.height - 110);
    const bandW = W - 2 * M;
    if (d.status === 'approved') {
      doc.roundedRect(M, bandY, bandW, 40, 8).fillColor(GREEN).fill();
      doc.fillColor('#fff').font('BodyBold').fontSize(12).text('APPROVED', M + 16, bandY + 13);
      doc.font('Body').fontSize(10).fillColor('#EAFBF1')
         .text(`Approved by ${d.approver || 'reporting manager'}    ${d.approved_at || ''}`, M, bandY + 14, { width: bandW - 16, align: 'right' });
    } else if (d.status === 'rejected') {
      doc.roundedRect(M, bandY, bandW, 40, 8).fillColor(RED).fill();
      doc.fillColor('#fff').font('BodyBold').fontSize(12).text('NOT APPROVED', M + 16, bandY + 13);
      doc.font('Body').fontSize(10).fillColor('#FCE9E9')
         .text(`Rejected by ${d.approver || 'reporting manager'}    ${d.approved_at || ''}`, M, bandY + 14, { width: bandW - 16, align: 'right' });
    } else {
      doc.roundedRect(M, bandY, bandW, 40, 8).fillColor(MIST).strokeColor(LINE).lineWidth(1).fillAndStroke();
      doc.fillColor(GRAY).font('Body').fontSize(10)
         .text('Pending — awaiting reporting manager approval.', M + 16, bandY + 15);
    }
    doc.end();
  });
}

// ---- Outstation summary (multi-page aware) ----
const CATLABEL = { long_distance: 'Long-Distance Travel', accommodation: 'Accommodation', food: 'Food', conveyance: 'Local Conveyance', others: 'Other' };
function empBlock(doc, d, W, M) {
  let y = 142; const colW = (W - 2 * M) / 4;
  kv(doc, M, y, 'Name', d.emp_name, colW - 8); kv(doc, M + colW, y, 'Emp Code', d.emp_code, colW - 8);
  kv(doc, M + 2 * colW, y, 'Designation', d.designation, colW - 8); kv(doc, M + 3 * colW, y, 'Category', d.category, colW - 8);
  return y + 36;
}
function statusBand(doc, d, W, M, y) {
  const bandY = Math.max(y + 8, doc.page.height - 92);
  if (d.status === 'approved') {
    doc.roundedRect(M, bandY, W - 2 * M, 40, 8).fillColor(GREEN).fill();
    doc.fillColor('#fff').font('BodyBold').fontSize(12).text('APPROVED', M + 16, bandY + 13);
    doc.font('Body').fontSize(10).fillColor('#EAFBF1')
       .text(`Approved by ${d.approver}    ${d.approved_at}`, M, bandY + 14, { width: W - 2 * M - 16, align: 'right' });
  } else if (d.status === 'generated') {
    doc.roundedRect(M, bandY, W - 2 * M, 40, 8).fillColor(MIST).strokeColor(LINE).lineWidth(1).fillAndStroke();
    doc.fillColor(GRAY).font('Body').fontSize(10).text(`Generated ${d.generated_at || ''}`, M + 16, bandY + 15);
  } else {
    doc.roundedRect(M, bandY, W - 2 * M, 40, 8).fillColor(MIST).strokeColor(LINE).lineWidth(1).fillAndStroke();
    doc.fillColor(GRAY).font('Body').fontSize(10).text('Submitted to HR — pending approval.', M + 16, bandY + 15);
  }
}

function buildOutstationSummary(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0 }); useFonts(doc);
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const W = doc.page.width, H = doc.page.height, M = 44, BOTTOM = H - 110;
    header(doc, W, M, 'OUTSTATION TRAVEL', `Reimbursement claim · ${d.period_label}`);
    let y = empBlock(doc, d, W, M);
    const colW = (W - 2 * M) / 4;
    kv(doc, M, y, 'Reference', d.ref_no, colW * 2);
    kv(doc, M + 2 * colW, y, 'Daily limits', `Food ₹${d.limits.food} · Stay ₹${d.limits.accom}`, colW * 2);
    y += 44;

    const tableX = M, tableW = W - 2 * M;
    const cw = { cat: 92, date: 58, amt: 78 }; cw.desc = tableW - cw.cat - cw.date - cw.amt;
    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 50; } };
    const drawHead = () => {
      doc.rect(tableX, y, tableW, 20).fillColor(INK).fill();
      doc.fillColor('#fff').font('BodyBold').fontSize(8);
      doc.text('CATEGORY', tableX + 8, y + 6, { width: cw.cat - 8 });
      doc.text('DATE', tableX + cw.cat + 8, y + 6, { width: cw.date - 8 });
      doc.text('DESCRIPTION', tableX + cw.cat + cw.date + 8, y + 6, { width: cw.desc - 8 });
      doc.text('AMOUNT', tableX + tableW - cw.amt, y + 6, { width: cw.amt - 8, align: 'right' });
      y += 20;
    };

    (d.trips || []).forEach((trip, ti) => {
      ensure(80);
      doc.roundedRect(M, y, tableW, 34, 6).fillColor('#EAF2F8').fill();
      doc.fillColor(INK).font('BodyBold').fontSize(11).text(`Trip ${ti + 1}: ${trip.place || '—'}`, M + 12, y + 6, { width: tableW - 24, ellipsis: true });
      doc.fillColor(GRAY).font('Body').fontSize(8.5)
         .text(`${trip.from_date || ''} → ${trip.to_date || ''}    ·    ${trip.reason || ''}`, M + 12, y + 20, { width: tableW - 24, ellipsis: true });
      y += 42;
      drawHead();
      let sub = 0;
      (trip.items || []).forEach((it, i) => {
        ensure(20);
        if (y === 50) drawHead();
        if (i % 2) doc.rect(tableX, y, tableW, 18).fillColor(MIST).fill();
        doc.font('Body').fontSize(8.5).fillColor(INK);
        doc.text(CATLABEL[it.category] || it.category, tableX + 8, y + 5, { width: cw.cat - 8, ellipsis: true });
        doc.text(it.date || '', tableX + cw.cat + 8, y + 5, { width: cw.date - 8 });
        const desc = (it.desc || '') + (it.bill_name ? '  [bill]' : '');
        doc.text(desc, tableX + cw.cat + cw.date + 8, y + 5, { width: cw.desc - 8, ellipsis: true });
        doc.fillColor(it.flag ? '#B45309' : INK).font(it.flag ? 'BodyBold' : 'Body')
           .text(rupee(it.amount).replace('INR ', '₹') + (it.flag ? ' !' : ''), tableX + tableW - cw.amt, y + 5, { width: cw.amt - 8, align: 'right' });
        sub += Number(it.amount || 0); y += 18;
      });
      ensure(20);
      doc.rect(tableX, y, tableW, 18).fillColor('#F0F5FA').fill();
      doc.fillColor(GRAY).font('BodyBold').fontSize(8.5).text('Trip subtotal', tableX + 8, y + 5);
      doc.fillColor(INK).text(rupee(sub).replace('INR ', '₹'), tableX + tableW - cw.amt, y + 5, { width: cw.amt - 8, align: 'right' });
      y += 26;
    });

    ensure(60);
    doc.rect(tableX, y, tableW, 26).fillColor('#EAF2F8').fill();
    doc.fillColor(INK).font('BodyBold').fontSize(12).text('GRAND TOTAL', tableX + 10, y + 7);
    doc.text(rupee(d.total).replace('INR ', '₹'), tableX + tableW - cw.amt - 4, y + 7, { width: cw.amt, align: 'right' });
    y += 34;
    if (d.flags && d.flags.length) {
      ensure(20 + d.flags.length * 12);
      doc.fillColor('#B45309').font('BodyBold').fontSize(9).text('Flagged for HR review (over daily limit):', M, y); y += 14;
      doc.font('Body').fontSize(8.5).fillColor('#92400E');
      d.flags.forEach(f => { doc.text('•  ' + f, M + 8, y, { width: tableW - 16 }); y += 12; });
      y += 6;
    }
    statusBand(doc, d, W, M, y);
    doc.end();
  });
}

function buildMiscSummary(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0 }); useFonts(doc);
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const W = doc.page.width, H = doc.page.height, M = 44, BOTTOM = H - 110;
    header(doc, W, M, 'MISCELLANEOUS REIMBURSEMENT', d.subtitle || '');
    let y = empBlock(doc, d, W, M);
    kv(doc, M, y, 'Reference', d.ref_no, (W - 2 * M)); y += 40;
    const tableX = M, tableW = W - 2 * M;
    const cw = { date: 70, amt: 90 }; cw.desc = tableW - cw.date - cw.amt;
    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 50; } };
    doc.rect(tableX, y, tableW, 22).fillColor(INK).fill();
    doc.fillColor('#fff').font('BodyBold').fontSize(8.5);
    doc.text('DATE', tableX + 8, y + 7, { width: cw.date - 8 });
    doc.text('PURPOSE / DESCRIPTION', tableX + cw.date + 8, y + 7, { width: cw.desc - 8 });
    doc.text('AMOUNT', tableX + tableW - cw.amt, y + 7, { width: cw.amt - 8, align: 'right' });
    y += 22;
    (d.items || []).forEach((it, i) => {
      ensure(20);
      if (i % 2) doc.rect(tableX, y, tableW, 20).fillColor(MIST).fill();
      doc.font('Body').fontSize(9).fillColor(INK);
      doc.text(it.date || '', tableX + 8, y + 6, { width: cw.date - 8 });
      doc.text((it.desc || '') + (it.bill_name ? '  [bill]' : ''), tableX + cw.date + 8, y + 6, { width: cw.desc - 8, ellipsis: true });
      doc.text(rupee(it.amount).replace('INR ', '₹'), tableX + tableW - cw.amt, y + 6, { width: cw.amt - 8, align: 'right' });
      y += 20;
    });
    ensure(30);
    doc.rect(tableX, y, tableW, 24).fillColor('#EAF2F8').fill();
    doc.fillColor(INK).font('BodyBold').fontSize(11).text('TOTAL', tableX + 8, y + 7);
    doc.text(rupee(d.total).replace('INR ', '₹'), tableX + tableW - cw.amt, y + 7, { width: cw.amt - 8, align: 'right' });
    y += 34;
    statusBand(doc, { status: 'generated', generated_at: d.generated_at }, W, M, y);
    doc.end();
  });
}

// ---- merge bills onto the end of a summary PDF (each bill on its own page) ----
async function mergeBills(summaryBuffer, bills) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  const summary = await PDFDocument.load(summaryBuffer);
  (await out.copyPages(summary, summary.getPageIndices())).forEach(p => out.addPage(p));
  const A4 = [595.28, 841.89], margin = 36;
  for (const b of (bills || [])) {
    if (!b || !b.bytes) continue;
    const mime = (b.mime || '').toLowerCase();
    try {
      if (mime.includes('pdf')) {
        const doc = await PDFDocument.load(b.bytes, { ignoreEncryption: true });
        (await out.copyPages(doc, doc.getPageIndices())).forEach(p => out.addPage(p));
      } else {
        const img = mime.includes('png') ? await out.embedPng(b.bytes) : await out.embedJpg(b.bytes);
        const page = out.addPage(A4);
        const maxW = A4[0] - margin * 2, maxH = A4[1] - margin * 2 - 22;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        if (b.caption) page.drawText(String(b.caption).slice(0, 90), { x: margin, y: A4[1] - margin, size: 9 });
        page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2 - 6, width: w, height: h });
      }
    } catch (e) { /* skip an unreadable/odd bill rather than fail the whole PDF */ }
  }
  return Buffer.from(await out.save());
}

module.exports = { buildConveyancePDF, buildOutstationSummary, buildMiscSummary, mergeBills, header, kv, rupee };
