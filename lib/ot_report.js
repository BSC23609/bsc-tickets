const ExcelJS = require('exceljs');

// Management-approved OT report as an .xlsx (base64) for Accounts.
// Consolidated per employee — Name, Total Hours, Amount only (no dates / day-by-day).
async function buildOtReportXlsx(period, summary, detail /* detail unused: consolidated only */) {
  const monthName = new Date(period + '-01').toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BSC Portal';

  const s1 = wb.addWorksheet('Overtime');
  s1.mergeCells('A1:C1');
  s1.getCell('A1').value = `Overtime \u2014 ${monthName}  [APPROVED]`;
  s1.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF0A4566' } };
  s1.addRow([]);
  const head = s1.addRow(['Name', 'Total Hours', 'Amount (Rs.)']);
  head.font = { bold: true };
  s1.columns = [{ width: 32 }, { width: 14 }, { width: 16 }];
  let total = 0;
  summary.forEach(l => {
    total += Number(l.amount);
    s1.addRow([l.employee_name, Number(l.hours), Number(l.amount)]);
  });
  s1.addRow([]);
  const totRow = s1.addRow(['TOTAL', '', total]);
  totRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return { base64: Buffer.from(buf).toString('base64'), total, emp_count: summary.length, monthName };
}

module.exports = { buildOtReportXlsx };
