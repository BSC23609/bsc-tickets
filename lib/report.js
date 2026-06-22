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

async function dailyRows(dateISO, scope) {
  const holidaySet = new Set((await q(`SELECT to_char(d,'YYYY-MM-DD') AS d FROM holidays`)).rows.map((r) => r.d));
  const params = [dateISO, TZ];
  let scopeSql = '';
  if (scope && ((scope.categoryIds && scope.categoryIds.length) || (scope.tradeIds && scope.tradeIds.length))) {
    params.push(scope.categoryIds || [], scope.tradeIds || []);
    scopeSql = ` AND (t.category_id = ANY($3::int[]) OR t.trade_id = ANY($4::int[]))`;
  }
  const rows = (await q(
    `SELECT t.ref_no, t.subject, t.raised_at, t.status, t.resolved_at, t.closed_at, t.resolution_note,
            c.name AS category, r.name AS raised_by, l1.name AS assigned_to,
            to_char(t.raised_at AT TIME ZONE $2,'HH24:MI') AS raised_time
     FROM tickets t
     JOIN categories c ON c.id=t.category_id
     JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     WHERE (t.raised_at AT TIME ZONE $2)::date = $1${scopeSql}
     ORDER BY t.raised_at`, params)).rows;
  const now = Date.now();
  return rows.map((t, i) => {
    const endRef = t.status === 'closed' ? t.closed_at : (t.status === 'resolved' ? t.resolved_at : null);
    const mins = businessMinutesBetween(t.raised_at, endRef || now, holidaySet);
    return {
      sno: i + 1, ref_no: t.ref_no, raised_time: t.raised_time, task: t.subject,
      category: t.category, raised_by: t.raised_by, assigned_to: t.assigned_to || '—',
      status: STATUS[t.status] || t.status, hrs: hm(mins), open: !endRef,
      remark: t.resolution_note || '',
    };
  });
}

function summary(rows) {
  const closed = rows.filter((r) => !r.open).length;
  return { total: rows.length, open: rows.length - closed, closed };
}

function buildPdf(dateLabel, rows, opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    doc.registerFont('Body', FONT); doc.registerFont('Bold', FONTB); doc.font('Body');
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

    const W = 842, H = 595, M = 28;
    const PAD = 4, FS = 8, LINEGAP = 1;
    const tableW = W - 2 * M;

    // Ticket No removed; Task Name & Assigned To widened; Status narrowed. Task Name flexes.
    // opts.remark (per-person reports only) adds a Remark column; widths tighten and Task+Remark share the slack.
    const cols = opts.remark ? [
      { k: 'sno',         t: 'S.No',        w: 34,  a: 'left'  },
      { k: 'raised_time', t: 'Raised',      w: 40,  a: 'left'  },
      { k: 'task',        t: 'Task Name',   w: 0,   a: 'left'  },
      { k: 'category',    t: 'Category',    w: 78,  a: 'left'  },
      { k: 'raised_by',   t: 'Raised By',   w: 86,  a: 'left'  },
      { k: 'assigned_to', t: 'Assigned To', w: 92,  a: 'left'  },
      { k: 'status',      t: 'Status',      w: 50,  a: 'left'  },
      { k: 'hrs',         t: 'No. Hrs',     w: 42,  a: 'right' },
      { k: 'remark',      t: 'Remark',      w: 0,   a: 'left'  },
    ] : [
      { k: 'sno',         t: 'S.No',        w: 30,  a: 'left'  },
      { k: 'raised_time', t: 'Raised',      w: 44,  a: 'left'  },
      { k: 'task',        t: 'Task Name',   w: 0,   a: 'left'  },
      { k: 'category',    t: 'Category',    w: 96,  a: 'left'  },
      { k: 'raised_by',   t: 'Raised By',   w: 104, a: 'left'  },
      { k: 'assigned_to', t: 'Assigned To', w: 140, a: 'left'  },
      { k: 'status',      t: 'Status',      w: 56,  a: 'left'  },
      { k: 'hrs',         t: 'No. Hrs',     w: 46,  a: 'right' },
    ];
    // Distribute the remaining width across every flex column (w === 0).
    const flexIdx = cols.map((c, i) => (c.w === 0 ? i : -1)).filter((i) => i >= 0);
    const fixedW = cols.reduce((s, c) => s + c.w, 0);
    const each = Math.floor((tableW - fixedW) / flexIdx.length);
    flexIdx.forEach((i, k) => { cols[i].w = (k === flexIdx.length - 1) ? (tableW - fixedW - each * (flexIdx.length - 1)) : each; });

    const headerBand = () => {
      try { doc.image(GROUP, M, 22, { width: 80 }); } catch (e) {}
      try { doc.image(BSC, W - M - 92, 24, { width: 92 }); } catch (e) {}
      doc.fillColor(INK).font('Bold').fontSize(16).text('Daily Ticket Report', 0, 30, { align: 'center', width: W });
      doc.fillColor(GRAY).font('Body').fontSize(9).text(dateLabel, 0, 52, { align: 'center', width: W });
      return 80;
    };

    // Tallest cell decides the row height, so wrapped text never overlaps the next row.
    const rowHeight = (vals, bold) => {
      doc.font(bold ? 'Bold' : 'Body').fontSize(FS);
      let max = 0;
      cols.forEach((c, ci) => {
        const h = doc.heightOfString(String(vals[ci] ?? ''), { width: c.w - 2 * PAD, lineGap: LINEGAP });
        if (h > max) max = h;
      });
      return Math.max(16, Math.ceil(max) + 2 * PAD);
    };
    const drawRow = (vals, y, bold, fill) => {
      const h = rowHeight(vals, bold);
      if (fill) doc.rect(M, y, tableW, h).fill(fill);
      let x = M;
      cols.forEach((c, ci) => {
        doc.font(bold ? 'Bold' : 'Body').fontSize(FS).fillColor(INK)
           .text(String(vals[ci] ?? ''), x + PAD, y + PAD, { width: c.w - 2 * PAD, align: c.a, lineGap: LINEGAP });
        x += c.w;
      });
      doc.strokeColor(LINE).lineWidth(0.5).rect(M, y, tableW, h).stroke();
      return y + h;
    };

    let y = headerBand();
    y = drawRow(cols.map((c) => c.t), y, true, MIST);
    if (!rows.length) {
      doc.font('Body').fontSize(9).fillColor(GRAY).text('No tickets were raised on this day.', M, y + 12, { width: tableW, align: 'center' });
    }
    for (const r of rows) {
      const h = rowHeight(cols.map((c) => r[c.k]), false);
      if (y + h > H - 26) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 }); y = headerBand(); y = drawRow(cols.map((c) => c.t), y, true, MIST); }
      y = drawRow(cols.map((c) => r[c.k]), y, false, null);
    }
    doc.font('Body').fontSize(8).fillColor(GRAY)
       .text('Generated ' + new Date().toLocaleString('en-IN', { timeZone: TZ }), M, Math.min(y + 6, H - 14), { width: tableW, align: 'right' });
    doc.end();
  });
}

async function dailyReportPdf(dateISO, scope, subtitle, opts) {
  const rows = await dailyRows(dateISO, scope);
  const [y, m, d] = dateISO.split('-');
  const base = new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const label = subtitle ? `${base}  ·  ${subtitle}` : base;
  const pdf = await buildPdf(label, rows, opts || {});
  return { pdf, rows, summary: summary(rows), label };
}

// Send the day's reports: the full report to every overall recipient, plus a
// scope-filtered report to each enabled per-employee subscriber who has tickets.
async function dispatchDailyReports(dateISO) {
  const wati = require('./wati');
  const [y, m, d] = dateISO.split('-');
  const label = new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const out = { overall_sent: [], scoped_sent: [] };

  const fullRows = await dailyRows(dateISO);
  const sum = summary(fullRows);
  const cfg = (await q(`SELECT value FROM app_settings WHERE key='daily_report_phone'`)).rows[0];
  const phones = ((cfg && cfg.value) || process.env.DAILY_REPORT_PHONE || '')
    .split(/[\n,]/).map((s) => s.replace(/[^\d+]/g, '')).filter(Boolean);
  for (const phone of phones) {
    await wati.notify.dailyReport({ phone, name: 'Sir' }, { dateISO, label, ...sum });
    out.overall_sent.push(phone);
  }

  const subs = (await q(
    `SELECT s.employee_id, s.category_ids, s.trade_ids, e.name, e.phone
     FROM report_subscriptions s JOIN employees e ON e.id=s.employee_id
     WHERE s.enabled=TRUE`)).rows;
  for (const sub of subs) {
    if (!sub.phone) continue;
    const scope = { categoryIds: sub.category_ids || [], tradeIds: sub.trade_ids || [] };
    if (!scope.categoryIds.length && !scope.tradeIds.length) continue;
    const srows = await dailyRows(dateISO, scope);
    if (!srows.length) continue; // nothing in their scope today → leave blank (skip)
    const ssum = summary(srows);
    await wati.notify.myReport(
      { phone: sub.phone, name: (sub.name || '').split(' ')[0] || 'there' },
      { dateISO, label, ...ssum, empId: sub.employee_id });
    out.scoped_sent.push({ employee: sub.name, count: srows.length });
  }
  return { date: dateISO, ...sum, ...out };
}

module.exports = { dailyRows, dailyReportPdf, summary, dispatchDailyReports };
