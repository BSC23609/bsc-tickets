// Seed configuration: locations, categories/trades, and the routing matrix.
// Routing references employees by emp_no (resolved to ids during seed).

module.exports = {
  // Outpass/Gatepass approvers (admin-editable). HR is added later via the admin panel.
  outpass_approvers: [
    { label: 'Bakthavachalam', emp_no: 'BSC/006' },
    { label: 'Kannan',         emp_no: 'BSC/098' },
    { label: 'Goverdhan',      emp_no: 'CMD' },
    { label: 'Gourav',         emp_no: 'CEO' },
  ],

  locations: [
    'Office (Sales)', 'Office (Accounts)', 'Office (Reception)',
    "Office (Chairman's Cabin)", 'Office (Cafeteria)', 'PDQC Room',
    'Main Gate', 'Shed A', 'Shed B', 'Shed C', 'Shed E', 'Shed F',
    'Dispatch Container Room', 'Security Container Room',
    'Bike Parking Area', 'Labour Quarters',
  ],

  // Default cooling times (minutes) — admin-editable per category & level.
  // 120 = the agreed 2-hour default.
  categories: [
    {
      name: 'IT / Network / Devices',
      has_trades: false,
      l1: 'BSC/127',          // Balamurali Asothaman
      l2: 'BSC/006',          // Bakthavachalam C
      l3: null,
      wait_l1_l2_mins: 120,
      wait_l2_l3_mins: 120,
    },
    {
      name: 'Maintenance / Facilities',
      has_trades: true,
      l1: null,
      l2: 'BSC/098',          // Kannan K (shared L2 across all trades)
      l3: null,
      wait_l1_l2_mins: 120,
      wait_l2_l3_mins: 120,
      trades: [
        { name: 'Mechanical', l1: 'BSC/084' },  // Velu C
        { name: 'Electrical', l1: 'BSC/039' },  // Ragupathi C
        { name: 'Plumbing',   l1: 'BSC/039' },  // Ragupathi C
        { name: 'General',    l1: 'BSC/118' },  // Mathan M
      ],
    },
    {
      name: 'SAP',
      has_trades: false,
      l1: 'BSC/136',          // Nagasubramanian N
      l2: 'BSC/006',          // Bakthavachalam C
      l3: null,
      wait_l1_l2_mins: 120,
      wait_l2_l3_mins: 120,
    },
    {
      name: 'HR Query (HRM Request)',
      has_trades: false,
      l1: 'BSC/125',          // Aiswarya Prabhakaran
      l2: 'BSC/006',          // Bakthavachalam C
      l3: null,
      wait_l1_l2_mins: 120,
      wait_l2_l3_mins: 120,
    },
  ],

  priorities: ['Low', 'Medium', 'High', 'Critical'],   // fixed, not editable
};
