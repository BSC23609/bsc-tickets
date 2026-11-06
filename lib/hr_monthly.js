// Monthly OT + Shearing report emailed to HR as an editable Excel workbook.
// Pulled live from the DB (so it is always complete and accurate — no screenshots),
// amounts as plain numbers (no currency symbol). Triggered monthly by a GitHub Action
// hitting /api/cron/hr-monthly-ot (protected by CRON_SECRET), and callable manually.
const ExcelJS = require('exceljs');
const { q } = require('./db');
const graph = require('./graph');

const HR_EMAIL = process.env.HR_EMAIL || 'hr@bharatsteels.in';
const monthLabel = (p) => { const [y, m] = String(p).split('-'); return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }); };
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };

const NAVY = 'FF0A2B66';
const thin = { style: 'thin', color: { argb: 'FFDCE3EA' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function addSheet(wb, name, title, cols, rows, qtyFmt) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map((c) => ({ width: c.w }));
  ws.mergeCells(1, 1, 1, cols.length);
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 13, color: { argb: NAVY } };
  ws.getRow(1).height = 22;
  const hr = ws.addRow(cols.map((c) => c.h));
  hr.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { vertical: 'middle' }; c.border = BORDER; });
  let n = 0, total = 0;
  rows.forEach((r) => {
    n++; total += Number(r.amt || 0);
    const row = ws.addRow([n, r.code || '—', r.name || '', Number(r.qty || 0), Number(r.amt || 0)]);
    row.getCell(4).numFmt = qtyFmt; row.getCell(4).alignment = { horizontal: 'right' };
    row.getCell(5).numFmt = '#,##0'; row.getCell(5).alignment = { horizontal: 'right' };   // plain number, no symbol
    row.eachCell((c) => { c.border = BORDER; });
  });
  const tr = ws.addRow(['', '', 'Total', '', total]);
  tr.getCell(3).font = { bold: true }; tr.getCell(5).font = { bold: true };
  tr.getCell(5).numFmt = '#,##0'; tr.getCell(5).alignment = { horizontal: 'right' };
  tr.eachCell((c) => { c.border = BORDER; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; });
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return total;
}

async function buildWorkbookBuffer(month) {
  // OT staff (both companies) + OT labour, approved for the month — same basis as the in-app report.
  const otStaff = (await q(
    `SELECT e.emp_no AS code, e.name, COALESCE(SUM(o.hours),0) AS qty, COALESCE(SUM(o.amount),0) AS amt
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE o.status IN ('mgmt_approved','paid')
       AND o.ot_date >= ($1||'-01')::date AND o.ot_date < (($1||'-01')::date + interval '1 month')
     GROUP BY e.emp_no, e.name`, [month])).rows;
  const otLabour = (await q(
    `SELECT labour_code AS code, labour_name AS name, COALESCE(SUM(hours),0) AS qty, COALESCE(SUM(amount),0) AS amt
     FROM labour_ot WHERE period=$1 GROUP BY labour_code, labour_name`, [month])).rows;
  const shear = (await q(
    `SELECT labour_code AS code, labour_name AS name, COALESCE(SUM(days),0) AS qty, COALESCE(SUM(amount),0) AS amt
     FROM labour_shearing WHERE period=$1 GROUP BY labour_code, labour_name`, [month])).rows;

  const ot = otStaff.concat(otLabour).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  shear.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const wb = new ExcelJS.Workbook();
  const otCols = [{ h: 'S.No', w: 7 }, { h: 'CODE', w: 12 }, { h: 'NAME', w: 28 }, { h: 'HOURS', w: 10 }, { h: 'AMOUNT', w: 14 }];
  const shCols = [{ h: 'S.No', w: 7 }, { h: 'CODE', w: 12 }, { h: 'NAME', w: 28 }, { h: 'DAYS', w: 10 }, { h: 'AMOUNT', w: 14 }];
  const otTotal = addSheet(wb, 'Overtime', `Overtime — ${monthLabel(month)}`, otCols, ot, '0.00');
  const shTotal = addSheet(wb, 'Shearing', `Shed-B Shearing — ${monthLabel(month)}`, shCols, shear, '0.0');
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { buf, otTotal, shTotal, otCount: ot.length, shCount: shear.length };
}

// Build the workbook for `month` (default = previous month) and email it to HR.
async function emailMonthlyToHr(month) {
  const mo = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : prevMonth();
  const { buf, otTotal, shTotal, otCount, shCount } = await buildWorkbookBuffer(mo);
  if (!otCount && !shCount) return { ok: true, skipped: true, month: mo };
  const ok = await graph.sendMail({
    to: HR_EMAIL,
    subject: `Overtime & Shearing — ${monthLabel(mo)}`,
    html: `<p>Please find attached the Overtime &amp; Shearing report for <b>${monthLabel(mo)}</b> (editable Excel):</p>
           <ul><li>Overtime: ${otCount} people, ${otTotal.toLocaleString('en-IN')}</li>
           <li>Shed-B Shearing: ${shCount} people, ${shTotal.toLocaleString('en-IN')}</li></ul>`,
    attachments: [{
      name: `OT_Shearing_${mo}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBytes: buf.toString('base64'),
    }],
  });
  return { ok, month: mo, to: HR_EMAIL, otCount, shCount, otTotal, shTotal };
}

module.exports = { buildWorkbookBuffer, emailMonthlyToHr, HR_EMAIL };
