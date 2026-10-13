// "Canteen Log.xlsx" on the hr@ OneDrive — a formatted, read-only mirror of the canteen register,
// rebuilt from the DB and replaced in one upload (same pattern as the ticket / outpass logs).
// Sheets: Entries (one row per date + item), Monthly Summary (category x month, like the old
// CONSOLIDATED), Item Totals (the print data for every month) and Items (the item master).
const ExcelJS = require('exceljs');
const { q } = require('./db');
const graph = require('./graph');
const C = require('./canteen');

const BRAND = 'FF0A4566', BRAND_SOFT = 'FFE8F1F8', BAND = 'FFF5F8FB', LINE = 'FFD5DEE6';
const INR = '#,##0;-#,##0;"-"';
const QTY = '#,##0.###;-#,##0.###;"-"';

function styleHeader(ws, ncols) {
  const row = ws.getRow(1);
  row.height = 22;
  for (let c = 1; c <= ncols; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF112532' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
function band(ws, fromRow, ncols) {
  for (let r = fromRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ncols; c++) {
      const cell = row.getCell(c);
      cell.border = { bottom: { style: 'thin', color: { argb: LINE } } };
      if ((r - fromRow) % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
    }
  }
}

async function buildCanteenWorkbook() {
  const entries = (await q(
    `SELECT to_char(e.entry_date,'YYYY-MM-DD') AS d, i.name, i.category, e.qty, e.amount,
            e.updated_by_name, e.updated_at
       FROM canteen_entries e JOIN canteen_items i ON i.id=e.item_id
      ORDER BY e.entry_date, i.sort_order, i.name`)).rows;
  const items = (await q(`SELECT * FROM canteen_items ORDER BY sort_order, name`)).rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BSC Portal — Canteen'; wb.created = new Date();

  // 1. Entries
  const es = wb.addWorksheet('Entries', { properties: { tabColor: { argb: BRAND } } });
  es.columns = [
    { header: 'Date', key: 'd', width: 13 }, { header: 'Month', key: 'm', width: 11 },
    { header: 'Item', key: 'name', width: 38 }, { header: 'Category', key: 'category', width: 22 },
    { header: 'Qty', key: 'qty', width: 9 }, { header: 'Amount (₹)', key: 'amount', width: 13 },
    { header: 'Entered by', key: 'by', width: 20 }, { header: 'Last updated', key: 'at', width: 18 },
  ];
  for (const e of entries) {
    const [y, m, d] = e.d.split('-').map(Number);
    es.addRow({ d: new Date(Date.UTC(y, m - 1, d)), m: C.monthLabel(e.d.slice(0, 7)), name: e.name,
      category: e.category, qty: C.num(e.qty), amount: C.num(e.amount), by: e.updated_by_name || '',
      at: e.updated_at ? new Date(e.updated_at) : null });
  }
  styleHeader(es, 8); band(es, 2, 8);
  es.getColumn('d').numFmt = 'dd-mmm-yyyy'; es.getColumn('at').numFmt = 'dd-mmm-yyyy hh:mm';
  es.getColumn('qty').numFmt = QTY; es.getColumn('amount').numFmt = INR;
  es.autoFilter = { from: 'A1', to: 'H1' };

  // 2. Monthly Summary — every month that has entries, category rows + cook salary + total
  const months = [...new Set(entries.map((e) => e.d.slice(0, 7)))].sort();
  const cats = (await q(`SELECT name FROM canteen_categories ORDER BY sort_order, name`)).rows.map((r) => r.name);
  const grid = {};
  for (const e of entries) {
    if (!cats.includes(e.category)) cats.push(e.category);
    const k = e.category + '|' + e.d.slice(0, 7);
    grid[k] = (grid[k] || 0) + C.num(e.amount);
  }
  const cook = {};
  (await q(`SELECT month, amount FROM canteen_cook_salary`)).rows.forEach((r) => { cook[r.month] = C.num(r.amount); });
  const ss = wb.addWorksheet('Monthly Summary');
  ss.columns = [{ header: 'Category', key: 'c', width: 24 },
    ...months.map((mk) => ({ header: C.monthLabel(mk), key: mk, width: 12 })),
    { header: 'Total', key: 'tot', width: 13 }];
  const ncol = months.length + 2;
  for (const c of cats) {
    const row = { c }; let t = 0;
    months.forEach((mk) => { const v = grid[c + '|' + mk] || 0; row[mk] = v; t += v; });
    row.tot = t; ss.addRow(row);
  }
  const cookRow = { c: 'COOK SALARY' }; let ct = 0;
  months.forEach((mk) => { cookRow[mk] = cook[mk] || 0; ct += cook[mk] || 0; }); cookRow.tot = ct;
  ss.addRow(cookRow);
  styleHeader(ss, ncol); band(ss, 2, ncol);
  const lastData = ss.rowCount;
  const totRow = ss.addRow({ c: 'TOTAL' });
  for (let col = 2; col <= ncol; col++) {
    const L = ss.getColumn(col).letter;
    totRow.getCell(col).value = { formula: `SUM(${L}2:${L}${lastData})` };
  }
  totRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_SOFT } };
    cell.border = { top: { style: 'medium', color: { argb: 'FF112532' } } };
  });
  for (let col = 2; col <= ncol; col++) ss.getColumn(col).numFmt = INR;
  ss.getColumn(ncol).font = { bold: true };

  // 3. Item Totals — month by month, in print order (what the print sheet shows)
  const it = wb.addWorksheet('Item Totals');
  it.columns = [{ header: 'Month', key: 'm', width: 11 }, { header: 'S.No', key: 'n', width: 7 },
    { header: 'Item', key: 'name', width: 38 }, { header: 'Category', key: 'category', width: 22 },
    { header: 'Qty', key: 'qty', width: 9 }, { header: 'Amount (₹)', key: 'amount', width: 13 }];
  for (const mk of [...months].reverse()) {
    const rows = await C.monthItemTotals(mk);
    rows.forEach((r, i) => it.addRow({ m: C.monthLabel(mk), n: i + 1, name: r.name, category: r.category, qty: r.qty, amount: r.amount }));
  }
  styleHeader(it, 6); band(it, 2, 6);
  it.getColumn('qty').numFmt = QTY; it.getColumn('amount').numFmt = INR;
  it.autoFilter = { from: 'A1', to: 'F1' };

  // 4. Items
  const im = wb.addWorksheet('Items');
  im.columns = [{ header: 'Item', key: 'name', width: 38 }, { header: 'Category', key: 'category', width: 22 },
    { header: 'Rate (₹)', key: 'rate', width: 11 }, { header: 'In daily list', key: 'vis', width: 13 }];
  items.forEach((i) => im.addRow({ name: i.name, category: i.category, rate: C.num(i.rate), vis: i.hidden ? 'Hidden' : 'Yes' }));
  styleHeader(im, 4); band(im, 2, 4);
  im.getColumn('rate').numFmt = '#,##0.00';
  im.autoFilter = { from: 'A1', to: 'D1' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Coalesce bursts of saves on one instance: at most one rebuild running, plus one queued.
let running = null, again = false;
async function syncCanteenLog() {
  if (!graph.configured()) return false;
  if (running) { again = true; return running; }
  running = (async () => {
    let ok = false;
    do { again = false; ok = await graph.uploadCanteenLog(await buildCanteenWorkbook()); } while (again);
    return ok;
  })().finally(() => { running = null; });
  return running;
}

module.exports = { buildCanteenWorkbook, syncCanteenLog };
