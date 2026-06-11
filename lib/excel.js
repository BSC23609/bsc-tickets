// Builds the complete ticket log workbook FROM THE DATABASE (the source of truth),
// so the Excel file is always a correct, full record of every request + its process.
// Two sheets: "Tickets" (one row per ticket, current state) and "Timeline"
// (one row per lifecycle event). Rebuild-and-replace — no fragile row patching.
const ExcelJS = require('exceljs');
const { q } = require('./db');
const graph = require('./graph');

function mins(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 60000);
}
const dt = (v) => (v ? new Date(v) : null);

async function buildWorkbookBuffer() {
  const tickets = (await q(`
    SELECT t.ref_no, t.raised_at, t.priority, t.subject, t.status, t.escalation_level,
           t.in_progress_at, t.escalated_l2_at, t.escalated_l3_at, t.resolved_at, t.closed_at,
           t.closed_auto, t.resolution_note, t.location_text,
           c.name AS category, tr.name AS trade,
           r.name AS requester, r.department AS dept,
           l1.name AS l1, l2.name AS l2, l3.name AS l3
    FROM tickets t
    JOIN categories c ON c.id=t.category_id
    LEFT JOIN trades tr ON tr.id=t.trade_id
    JOIN employees r ON r.id=t.requester_id
    LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
    LEFT JOIN employees l2 ON l2.id=t.l2_emp_id
    LEFT JOIN employees l3 ON l3.id=t.l3_emp_id
    ORDER BY t.raised_at`)).rows;

  const events = (await q(`
    SELECT t.ref_no, e.event, emp.name AS by_name, e.at, e.note
    FROM ticket_events e
    JOIN tickets t ON t.id=e.ticket_id
    LEFT JOIN employees emp ON emp.id=e.by_emp_id
    ORDER BY t.raised_at, e.at`)).rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BSC Ticket Management';
  wb.created = new Date();

  const ts = wb.addWorksheet('Tickets');
  ts.columns = [
    { header: 'Ref No', key: 'ref_no', width: 22 },
    { header: 'Raised At', key: 'raised_at', width: 18 },
    { header: 'Requester', key: 'requester', width: 20 },
    { header: 'Department', key: 'dept', width: 16 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Trade', key: 'trade', width: 14 },
    { header: 'Priority', key: 'priority', width: 10 },
    { header: 'Location', key: 'location_text', width: 22 },
    { header: 'Subject', key: 'subject', width: 36 },
    { header: 'Status', key: 'status', width: 13 },
    { header: 'Escalation', key: 'escalation_level', width: 11 },
    { header: 'L1', key: 'l1', width: 18 },
    { header: 'L2', key: 'l2', width: 18 },
    { header: 'L3', key: 'l3', width: 18 },
    { header: 'In Progress At', key: 'in_progress_at', width: 18 },
    { header: 'Escalated L2 At', key: 'escalated_l2_at', width: 18 },
    { header: 'Escalated L3 At', key: 'escalated_l3_at', width: 18 },
    { header: 'Resolved At', key: 'resolved_at', width: 18 },
    { header: 'Closed At', key: 'closed_at', width: 18 },
    { header: 'Auto Closed', key: 'closed_auto', width: 12 },
    { header: 'Downtime (min)', key: 'downtime', width: 14 },
    { header: 'Resolution Note', key: 'resolution_note', width: 40 },
  ];
  for (const t of tickets) {
    ts.addRow({
      ...t,
      escalation_level: t.escalation_level ? `L${t.escalation_level}` : '-',
      raised_at: dt(t.raised_at), in_progress_at: dt(t.in_progress_at),
      escalated_l2_at: dt(t.escalated_l2_at), escalated_l3_at: dt(t.escalated_l3_at),
      resolved_at: dt(t.resolved_at), closed_at: dt(t.closed_at),
      closed_auto: t.closed_auto ? 'Yes' : '',
      downtime: mins(t.raised_at, t.closed_at),
    });
  }
  ts.getRow(1).font = { bold: true };
  ts.views = [{ state: 'frozen', ySplit: 1 }];
  ts.autoFilter = 'A1:V1';

  const es = wb.addWorksheet('Timeline');
  es.columns = [
    { header: 'Ref No', key: 'ref_no', width: 22 },
    { header: 'Event', key: 'event', width: 18 },
    { header: 'By', key: 'by_name', width: 20 },
    { header: 'At', key: 'at', width: 18 },
    { header: 'Note', key: 'note', width: 44 },
  ];
  const labelOf = (e) => ({ raised: 'Raised', in_progress: 'In Progress', escalated_l2: 'Escalated L2',
    escalated_l3: 'Escalated L3', resolved: 'Resolved', confirmed_closed: 'Closed (confirmed)',
    auto_closed: 'Auto Closed', reopened: 'Reopened' }[e] || e);
  for (const ev of events) es.addRow({ ...ev, event: labelOf(ev.event), at: dt(ev.at) });
  es.getRow(1).font = { bold: true };
  es.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Build from DB and replace the OneDrive file in one upload. Safe to call often.
async function syncLogToOneDrive() {
  if (!graph.configured()) return false;
  const buf = await buildWorkbookBuffer();
  return graph.uploadLogFile(buf);
}

module.exports = { buildWorkbookBuffer, syncLogToOneDrive };
