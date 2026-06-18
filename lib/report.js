// Daily ticket report: one row per ticket raised that day (IST), rendered to a
// landscape A4 PDF. "No. Hrs" = working time since raised (open) or raised→closed.
const PDFDocument = require('pdfkit');
const path = require('path');
const { q } = require('./db');
const { businessMinutesBetween } = require('./util');

const GROUP = path.join(__dirname, '..', 'public', 'img', 'group-logo.png');
const BSC = path.join(__dirname, '..', 'public', 'img', 'bsc-logo.png');
const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONTB = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const INK = '#112532', GRAY = '#8A97A3', LINE = '#D8E0E8', MIST = '#F5F8FB';
const TZ = 'Asia/Kolkata';

const hm = (m) => Math.floor(Math.max(0, m) / 60) + ':' + String(Math.max(0, m) % 60).padStart(2, '0');
const STATUS = { open: 'Open', in_progress: 'In progress', reopened: 'Reopened', resolved: 'Resolved', closed: 'Closed' };

async function dailyRows(dateISO) {
  const holidaySet = new Set((await q(`SELECT to_char(d,'YYYY-MM-DD') AS d FROM holidays`)).rows.map((r) => r.d));
  const rows = (await q(
    `SELECT t.ref_no, t.subject, t.raised_at, t.status, t.resolved_at, t.closed_at,
            c.name AS category, r.name AS raised_by, l1.name AS assigned_to,
            to_char(t.raised_at AT TIME ZONE $2,'HH24:MI') AS raised_time
     FROM tickets t
     JOIN categories c ON c.id=t.category_id
     JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     WHERE (t.raised_at AT TIME ZONE $2)::date = $1
     ORDER BY t.raised_at`, [dateISO, TZ])).rows;
  const now = Date.now();
  return rows.map((t, i) => {
    const endRef = t.status === 'closed' ? t.closed_at : (t.status === 'resolved' ? t.resolved_at : null);
    const mins = businessMinutesBetween(t.raised_at, endRef || now, holidaySet);
    return {
      sno: i + 1, ref_no: t.ref_no, raised_time: t.raised_time, task: t.subject,
      category: t.category, raised_by: t.raised_by, assigned_to: t.assigned_to || '—',
      status: STATUS[t.status] || t.status, hrs: hm(mins), open: !endRef,
    };
  });
}

function summary(rows) {
  const closed = rows.filter((r) => !r.open).length;
  return { total: rows.length, open: rows.length - closed, closed };
}

function buildPdf(dateLabel, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    doc.registerFont('Body', FONT); doc.registerFont('Bold', FONTB); doc.font('Body');
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

    const W = 842, H = 595, M = 28;
    try { doc.image(GROUP, M, 22, { width: 80 }); } catch (e) {}
    try { doc.image(BSC, W - M - 92, 24, { width: 92 }); } catch (e) {}
    doc.fillColor(INK).font('Bold').fontSize(16).text('Daily Ticket Report', 0, 30, { align: 'center', width: W });
    doc.fillColor(GRAY).font('Body').fontSize(9).text(dateLabel, 0, 52, { align: 'center', width: W });

    const cols = [
      { k: 'sno', t: 'S.No', w: 34, a: 'left' },
      { k: 'ref_no', t: 'Ticket No', w: 118, a: 'left' },
      { k: 'raised_time', t: 'Raised', w: 44, a: 'left' },
      { k: 'task', t: 'Task Name', w: 158, a: 'left' },
      { k: 'category', t: 'Category', w: 88, a: 'left' },
      { k: 'raised_by', t: 'Raised By', w: 86, a: 'left' },
      { k: 'assigned_to', t: 'Assigned To', w: 86, a: 'left' },
      { k: 'status', t: 'Status', w: 62, a: 'left' },
      { k: 'hrs', t: 'No. Hrs', w: 0, a: 'right' },
    ];
    const tableW = W - 2 * M;
    cols[cols.length - 1].w = tableW - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);

    let y = 80; const rowH = 18;
    const drawRow = (vals, bold, fill) => {
      if (fill) doc.rect(M, y, tableW, rowH).fill(fill);
      let x = M;
      cols.forEach((c, ci) => {
        doc.font(bold ? 'Bold' : 'Body').fontSize(8).fillColor(INK)
           .text(String(vals[ci] ?? ''), x + 4, y + 5, { width: c.w - 8, align: c.a, ellipsis: true, lineBreak: false });
        x += c.w;
      });
      doc.strokeColor(LINE).lineWidth(0.5).rect(M, y, tableW, rowH).stroke();
      y += rowH;
    };

    drawRow(cols.map((c) => c.t), true, MIST);
    if (!rows.length) {
      doc.font('Body').fontSize(9).fillColor(GRAY).text('No tickets were raised on this day.', M, y + 12, { width: tableW, align: 'center' });
    }
    for (const r of rows) {
      if (y > H - 40) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 }); y = 36; drawRow(cols.map((c) => c.t), true, MIST); }
      drawRow(cols.map((c) => r[c.k]), false, null);
    }
    doc.font('Body').fontSize(8).fillColor(GRAY)
       .text('Generated ' + new Date().toLocaleString('en-IN', { timeZone: TZ }), M, H - 22, { width: tableW, align: 'right' });
    doc.end();
  });
}

async function dailyReportPdf(dateISO) {
  const rows = await dailyRows(dateISO);
  const [y, m, d] = dateISO.split('-');
  const label = new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const pdf = await buildPdf(label, rows);
  return { pdf, rows, summary: summary(rows), label };
}

module.exports = { dailyRows, dailyReportPdf, summary };
