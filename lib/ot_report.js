const ExcelJS = require('exceljs');

// Build the management-approved OT report as an .xlsx (base64) for emailing to Accounts.
// Sheet 1 = per-employee summary, Sheet 2 = day-by-day detail.
async function buildOtReportXlsx(period, summary, detail) {
  const monthName = new Date(period + '-01').toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BSC Portal';

  const s1 = wb.addWorksheet('Summary');
  s1.mergeCells('A1:F1');
  s1.getCell('A1').value = `Approved Overtime — ${monthName}`;
  s1.getCell('A1').font = { bold: true, size: 14 };
  s1.addRow([]);
  const head = s1.addRow(['Employee', 'Code', 'Department', 'OT Days', 'Total Hours', 'Amount (Rs.)']);
  head.font = { bold: true };
  s1.columns = [{ width: 28 }, { width: 12 }, { width: 16 }, { width: 10 }, { width: 12 }, { width: 14 }];
  let total = 0;
  summary.forEach(l => {
    total += Number(l.amount);
    s1.addRow([l.employee_name, l.emp_no || '', l.department || '', Number(l.days), Number(l.hours), Number(l.amount)]);
  });
  s1.addRow([]);
  const totRow = s1.addRow(['', '', '', '', 'TOTAL', total]);
  totRow.font = { bold: true };

  const s2 = wb.addWorksheet('Day-by-day');
  const h2 = s2.addRow(['Employee', 'Code', 'Date', 'OT End', 'Hours', 'Amount (Rs.)', 'Late?']);
  h2.font = { bold: true };
  s2.columns = [{ width: 28 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 8 }];
  detail.forEach(r => s2.addRow([r.employee_name, r.emp_no || '', r.ot_date, r.end_time, Number(r.hours), Number(r.amount), r.is_late ? 'LATE' : '']));

  const buf = await wb.xlsx.writeBuffer();
  return { base64: Buffer.from(buf).toString('base64'), total, emp_count: summary.length, monthName };
}

module.exports = { buildOtReportXlsx };
