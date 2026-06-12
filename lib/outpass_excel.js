// Builds the Outpass/Gatepass register from the DB (source of truth) and replaces
// the single "Outpass Log.xlsx" in the hr@ OneDrive folder. Logs every request and
// its outcome — approved and rejected alike.
const ExcelJS = require('exceljs');
const { q } = require('./db');
const graph = require('./graph');

const dt = (v) => (v ? new Date(v) : null);

async function buildOutpassWorkbook() {
  const rows = (await q(`
    SELECT o.ref_no, o.type, o.on_duty, o.req_date, o.purpose, o.out_time, o.in_time,
           o.approver_label, o.status, o.actioned_by_name, o.actioned_at, o.reject_reason, o.created_at,
           r.emp_no AS req_code, r.name AS req_name, r.job_title AS designation
    FROM outpass_requests o
    JOIN employees r ON r.id = o.requester_id
    ORDER BY o.created_at`)).rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BSC Portal'; wb.created = new Date();
  const ws = wb.addWorksheet('Outpass & Gatepass');
  ws.columns = [
    { header: 'Ref No', key: 'ref_no', width: 22 },
    { header: 'Type', key: 'type', width: 11 },
    { header: 'On Duty', key: 'on_duty', width: 9 },
    { header: 'Date', key: 'req_date', width: 13 },
    { header: 'Emp Code', key: 'req_code', width: 12 },
    { header: 'Name', key: 'req_name', width: 20 },
    { header: 'Designation', key: 'designation', width: 22 },
    { header: 'Purpose', key: 'purpose', width: 34 },
    { header: 'Out-Time', key: 'out_time', width: 12 },
    { header: 'In-Time', key: 'in_time', width: 12 },
    { header: 'Approver', key: 'approver_label', width: 18 },
    { header: 'Status', key: 'status', width: 11 },
    { header: 'Actioned By', key: 'actioned_by_name', width: 20 },
    { header: 'Actioned At', key: 'actioned_at', width: 18 },
    { header: 'Reject Reason', key: 'reject_reason', width: 30 },
    { header: 'Submitted At', key: 'created_at', width: 18 },
  ];
  for (const o of rows) {
    ws.addRow({
      ...o,
      type: o.type === 'gatepass' ? 'Gatepass' : 'Outpass',
      on_duty: o.on_duty ? 'Yes' : '',
      req_date: dt(o.req_date),
      status: o.status.charAt(0).toUpperCase() + o.status.slice(1),
      actioned_at: dt(o.actioned_at),
      created_at: dt(o.created_at),
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = 'A1:P1';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function syncOutpassLog() {
  if (!graph.configured()) return false;
  return graph.uploadOutpassLog(await buildOutpassWorkbook());
}

module.exports = { buildOutpassWorkbook, syncOutpassLog };
