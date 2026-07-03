// Consolidated monthly reimbursement report (approved-only) for the CMD.
const ExcelJS = require('exceljs');
const jwt = require('jsonwebtoken');
const { q } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const FORM_LABEL = { conveyance: 'Local Conveyance', outstation: 'Outstation', misc: 'Miscellaneous' };
const CUTOVER_PERIOD = '2026-07';
const BASE_URL = (process.env.APP_BASE_URL || 'https://tickets.bharatsteels.in').replace(/\/+$/, '');

function cycleRange(period) { const [y, m] = period.split('-').map(Number);
  const start = period === CUTOVER_PERIOD ? new Date(2026, 6, 1) : new Date(y, m - 2, 26);
  return { start, end: new Date(y, m - 1, 25) }; }
function cycleLabel(period) { const { start, end } = cycleRange(period);
  const f = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `${f(start)} – ${f(end)} ${end.getFullYear()}`; }
// Pre-cutover months (June 2026 and earlier) were plain calendar months; label them as such.
function cycleOf(d) { d = new Date(String(d).slice(0,10) + 'T00:00:00'); let y = d.getFullYear(), m = d.getMonth(); if (d.getDate() >= 26) { m++; if (m > 11) { m = 0; y++; } } return `${y}-${String(m + 1).padStart(2, '0')}`; }
function reportBucket(dateStr) { const d = new Date(String(dateStr).slice(0,10) + 'T00:00:00'); const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; return ym < CUTOVER_PERIOD ? ym : cycleOf(dateStr); }
// Misc claims carry no period key; bucket them by their latest item date.
function miscPeriod(payload) { const items = (payload && payload.items) || []; const dates = items.map(i => i.date).filter(Boolean).sort(); return dates.length ? reportBucket(dates[dates.length - 1]) : null; }
function reportLabel(period) {
  if (period < CUTOVER_PERIOD) { const [y, m] = period.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }); }
  return cycleLabel(period);
}

async function reportData(period) {
  const direct = (await q(`SELECT s.ref_no, s.form_type, s.total_amount, s.final_at, s.final_by_name, s.pdf_token,
      e.name AS emp_name, e.emp_no
    FROM expense_submissions s JOIN employees e ON e.id=s.employee_id
    WHERE s.status='approved' AND s.period=$1`, [period])).rows;
  // Legacy misc claims saved without a period — bucket by item date so they still appear.
  const legacyMisc = (await q(`SELECT s.ref_no, s.form_type, s.total_amount, s.final_at, s.final_by_name, s.pdf_token, s.payload,
      e.name AS emp_name, e.emp_no
    FROM expense_submissions s JOIN employees e ON e.id=s.employee_id
    WHERE s.status='approved' AND s.form_type='misc' AND s.period IS NULL`)).rows
    .filter(r => miscPeriod(r.payload) === period)
    .map(({ payload, ...r }) => r);
  const rows = [...direct, ...legacyMisc].sort((a, b) =>
    (a.emp_name || '').localeCompare(b.emp_name || '') || (a.form_type || '').localeCompare(b.form_type || ''));
  const total = rows.reduce((a, r) => a + Number(r.total_amount || 0), 0);
  return { rows, total, count: rows.length };
}

async function buildReportBuffer(period) {
  const { rows, total } = await reportData(period);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BSC Expense';

  const ws = wb.addWorksheet('Reimbursements');
  ws.columns = [
    { header: 'Emp ID', key: 'emp_no', width: 14 },
    { header: 'Employee', key: 'emp_name', width: 26 },
    { header: 'Type', key: 'type', width: 18 },
    { header: 'Ref No', key: 'ref_no', width: 28 },
    { header: 'Amount (INR)', key: 'amount', width: 15 },
    { header: 'Approved On', key: 'approved', width: 18 },
    { header: 'Final Approver', key: 'approver', width: 22 },
    { header: 'PDF', key: 'pdf', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  for (const r of rows) ws.addRow({
    emp_no: r.emp_no, emp_name: r.emp_name, type: FORM_LABEL[r.form_type] || r.form_type,
    ref_no: r.ref_no, amount: Number(r.total_amount || 0),
    approved: r.final_at ? new Date(r.final_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '',
    approver: r.final_by_name || '',
    pdf: r.pdf_token ? { text: 'Open PDF', hyperlink: `${BASE_URL}/dlx/${r.pdf_token}` } : '',
  });
  ws.getColumn('amount').numFmt = '#,##0.00';
  ws.getColumn('pdf').eachCell((cell, rn) => { if (rn > 1 && cell.value && cell.value.hyperlink) cell.font = { color: { argb: 'FF0563C1' }, underline: true }; });
  const tr = ws.addRow({ emp_name: 'TOTAL', amount: total });
  tr.font = { bold: true }; ws.getCell(`E${tr.number}`).numFmt = '#,##0.00';

  // Summary by employee
  const byEmp = {};
  for (const r of rows) { const k = r.emp_no;
    byEmp[k] = byEmp[k] || { emp_no: r.emp_no, emp_name: r.emp_name, count: 0, amount: 0 };
    byEmp[k].count++; byEmp[k].amount += Number(r.total_amount || 0); }
  const ss = wb.addWorksheet('Summary by Employee');
  ss.columns = [
    { header: 'Emp ID', key: 'emp_no', width: 14 },
    { header: 'Employee', key: 'emp_name', width: 26 },
    { header: 'Claims', key: 'count', width: 10 },
    { header: 'Total (INR)', key: 'amount', width: 16 },
  ];
  ss.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ss.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
  Object.values(byEmp).sort((a, b) => b.amount - a.amount).forEach(e => ss.addRow(e));
  ss.getColumn('amount').numFmt = '#,##0.00';
  const st = ss.addRow({ emp_name: 'TOTAL', amount: total });
  st.font = { bold: true }; ss.getCell(`D${st.number}`).numFmt = '#,##0.00';

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reportFileName(period) {
  return `BSC Reimbursements ${reportLabel(period)}.xlsx`
    .replace(/[\u2013\u2014]/g, '-')      // en/em dash -> hyphen (headers must be ASCII)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[^\x20-\x7E]/g, '');        // strip any remaining non-ASCII
}
function signLink(period) { return jwt.sign({ period, kind: 'exprep' }, SECRET, { expiresIn: '60d' }); }
function verifyLink(token) { try { const p = jwt.verify(token, SECRET); return p.kind === 'exprep' ? p.period : null; } catch { return null; } }

module.exports = { reportData, buildReportBuffer, reportFileName, cycleLabel, reportLabel, miscPeriod, signLink, verifyLink };
