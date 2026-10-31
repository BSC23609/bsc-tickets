// Monthly canteen print sheet (A4 portrait, one page) — same layout as the old Excel "Print" sheet:
// store + month title, two side-by-side S.NO / ITEM NAME / QTY / AMOUNT columns, the last three
// months' totals bottom-left and the Grand Total bottom-right. Rows shrink to fit if a month has
// more than 86 items, so nothing is ever cut off.
const PDFDocument = require('pdfkit');

const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');
const fmtQty = (n) => { const v = Number(n || 0); return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 3 }); };

function buildCanteenPdf(model) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const mm = (v) => v * 72 / 25.4;
    const X = mm(10), W = mm(190), Y = mm(10), H = mm(277);
    // Vegetable store prints without the ITEM NAME column — only S.NO / QTY / AMOUNT per half.
    const veg = model.storeKey === 'vegetable';
    const widths = veg
      ? [14, 22, 28, 3, 14, 22, 28]
      : [8.57, 43.4, 10.5, 13.5, 2.4, 8.57, 41, 8.5, 13.5];
    const nL = veg ? 3 : 4;                 // columns per half
    const gapIdx = nL;                      // the middle gap column
    const L_sno = 0, L_name = veg ? -1 : 1, L_qty = veg ? 1 : 2, L_amt = veg ? 2 : 3;
    const R0 = gapIdx + 1;
    const R_sno = R0, R_name = veg ? -1 : R0 + 1, R_qty = veg ? R0 + 1 : R0 + 2, R_amt = veg ? R0 + 2 : R0 + 3;
    const lastIdx = widths.length;          // right edge
    const sum = widths.reduce((a, b) => a + b, 0);
    const cw = widths.map((v) => v / sum * W);
    const cx = [X]; cw.forEach((v) => cx.push(cx[cx.length - 1] + v));

    const half = Math.ceil(model.rows.length / 2);
    const R = Math.max(43, half);
    const rh = H / (R + 5);
    const fs = Math.min(11, rh * 0.62);
    const THIN = 0.6, MED = 1.6;

    const text = (s, x, y, w, align = 'center', bold = false, size = fs) => {
      s = String(s);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      const pad = 3.5;
      let z = size; doc.fontSize(z);
      while (z > 5 && doc.widthOfString(s) > w - 2 * pad) { z -= 0.25; doc.fontSize(z); }
      const tw = doc.widthOfString(s);
      const tx = align === 'left' ? x + pad : align === 'right' ? x + w - pad - tw : x + (w - tw) / 2;
      const ty = y + (rh - z) / 2 + z * 0.08;
      doc.text(s, tx, ty, { lineBreak: false });   // positioned by hand: never wraps into the next row
    };
    const line = (x1, y1, x2, y2, lw, dash) => {
      doc.save().lineWidth(lw);
      if (dash) doc.dash(2.5, { space: 2 });
      doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
      doc.restore();
    };

    let y = Y;
    text(`${model.store}   ${model.label}`, X, y, W, 'center', true, fs + 2);
    line(X, y, X + W, y, MED); line(X, y, X, y + rh, MED); line(X + W, y, X + W, y + rh, MED);
    y += rh;
    (veg ? ['S.NO', 'QTY', 'AMOUNT', '', 'S.NO', 'QTY', 'AMOUNT']
         : ['S.NO', 'ITEM NAME', 'QTY', 'AMOUNT', '', 'S.NO', 'ITEM NAME', 'QTY', 'AMOUNT'])
      .forEach((h, i) => { if (h) text(h, cx[i], y, cw[i], 'center', true); });
    line(X, y, X + W, y, MED); line(X, y + rh, X + W, y + rh, MED);
    y += rh;
    const bodyTop = y - rh;
    for (let i = 0; i < R; i++) {
      const L = i < half ? model.rows[i] : null;
      const Rr = model.rows[half + i];
      if (L) { text(i + 1, cx[L_sno], y, cw[L_sno]); if (!veg) text(L.name, cx[L_name], y, cw[L_name], 'left'); text(fmtQty(L.qty), cx[L_qty], y, cw[L_qty]); text(fmt(L.amount), cx[L_amt], y, cw[L_amt]); }
      if (Rr) { text(half + i + 1, cx[R_sno], y, cw[R_sno]); if (!veg) text(Rr.name, cx[R_name], y, cw[R_name], 'left'); text(fmtQty(Rr.qty), cx[R_qty], y, cw[R_qty]); text(fmt(Rr.amount), cx[R_amt], y, cw[R_amt]); }
      y += rh;
      line(cx[0], y, cx[gapIdx], y, THIN); line(cx[gapIdx + 1], y, cx[lastIdx], y, THIN);
    }
    for (let i = 0; i <= lastIdx; i++) line(cx[i], bodyTop, cx[i], y, [0, gapIdx, gapIdx + 1, lastIdx].includes(i) ? MED : THIN);
    line(X, y, X + W, y, MED);

    const fTop = y;
    const footLblW = veg ? cw[L_sno] : cw[L_sno] + cw[L_name];
    model.footer.forEach((f) => {
      if (f) {
        text(f.label, cx[L_sno], y, footLblW, 'center', true);
        const bx = cx[L_qty], bw = cw[L_qty] + cw[L_amt];
        text(fmt(f.total), bx, y, bw, 'center', true);
        line(bx, y, bx + bw, y, THIN, true); line(bx, y + rh, bx + bw, y + rh, THIN, true);
        line(bx, y, bx, y + rh, THIN, true); line(bx + bw, y, bx + bw, y + rh, THIN, true);
      }
      y += rh;
    });
    const gy = fTop + rh;
    const gtLbl = veg ? R_sno : R_name, gtLblW = cw[gtLbl];
    const gvX = cx[R_qty], gvW = cw[R_qty] + cw[R_amt];
    doc.save().lineWidth(MED).rect(cx[gtLbl], gy, gtLblW, 2 * rh).stroke()
      .rect(gvX, gy, gvW, 2 * rh).stroke().restore();
    doc.font('Helvetica-Bold');
    const mid = (s, x, w) => { let z = fs + 1; doc.fontSize(z); while (z > 5 && doc.widthOfString(s) > w - 4) { z -= 0.25; doc.fontSize(z); } doc.text(s, x + (w - doc.widthOfString(s)) / 2, gy + rh - z / 2, { lineBreak: false }); };
    mid('Grand Total', cx[gtLbl], gtLblW);
    mid(fmt(model.total), gvX, gvW);
    line(X, fTop, X, y, MED); line(X + W, fTop, X + W, y, MED); line(X, y, X + W, y, MED);
    doc.end();
  });
}

module.exports = { buildCanteenPdf };
