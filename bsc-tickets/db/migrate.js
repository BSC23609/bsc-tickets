// Run with:  npm run migrate   (creates tables, seeds roster + routing)
// Safe to re-run: employees/locations/categories are upserted, not duplicated.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');
const roster = require('./roster.json');
const cfg = require('./seed-config');

const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Bsc@123';

async function main() {
  const client = await pool.connect();
  try {
    console.log('→ Applying schema…');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    console.log(`→ Seeding ${roster.length} employees…`);
    for (const e of roster) {
      await client.query(
        `INSERT INTO employees (emp_no,name,email,phone,department,job_title,app_role,is_admin,password_hash,must_reset)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
         ON CONFLICT (emp_no) DO UPDATE SET
           name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone,
           department=EXCLUDED.department, job_title=EXCLUDED.job_title,
           app_role=EXCLUDED.app_role, is_admin=EXCLUDED.is_admin`,
        [e.emp_no, e.name, e.email, e.phone, e.department, e.job_title, e.app_role, e.is_admin, hash]
      );
    }

    // map emp_no -> id
    const { rows: emps } = await client.query('SELECT id, emp_no FROM employees');
    const id = (emp_no) => {
      if (!emp_no) return null;
      const m = emps.find((x) => x.emp_no === emp_no);
      if (!m) throw new Error('Seed: unknown emp_no ' + emp_no);
      return m.id;
    };

    console.log('→ Seeding locations…');
    for (let i = 0; i < cfg.locations.length; i++) {
      const name = cfg.locations[i];
      const { rowCount } = await client.query('SELECT 1 FROM locations WHERE name=$1', [name]);
      if (!rowCount) await client.query('INSERT INTO locations(name,sort_order) VALUES($1,$2)', [name, i]);
    }

    console.log('→ Seeding categories, trades & routing…');
    for (let i = 0; i < cfg.categories.length; i++) {
      const c = cfg.categories[i];
      let { rows } = await client.query('SELECT id FROM categories WHERE name=$1', [c.name]);
      let catId;
      if (rows.length) {
        catId = rows[0].id;
        await client.query(
          `UPDATE categories SET has_trades=$2,l1_emp_id=$3,l2_emp_id=$4,l3_emp_id=$5,
             wait_l1_l2_mins=$6,wait_l2_l3_mins=$7,sort_order=$8 WHERE id=$1`,
          [catId, c.has_trades, id(c.l1), id(c.l2), id(c.l3), c.wait_l1_l2_mins, c.wait_l2_l3_mins, i]
        );
      } else {
        const r = await client.query(
          `INSERT INTO categories(name,has_trades,l1_emp_id,l2_emp_id,l3_emp_id,wait_l1_l2_mins,wait_l2_l3_mins,sort_order)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [c.name, c.has_trades, id(c.l1), id(c.l2), id(c.l3), c.wait_l1_l2_mins, c.wait_l2_l3_mins, i]
        );
        catId = r.rows[0].id;
      }
      if (c.has_trades && c.trades) {
        for (let j = 0; j < c.trades.length; j++) {
          const t = c.trades[j];
          const { rows: tr } = await client.query(
            'SELECT id FROM trades WHERE category_id=$1 AND name=$2', [catId, t.name]);
          if (tr.length) {
            await client.query('UPDATE trades SET l1_emp_id=$2,sort_order=$3 WHERE id=$1',
              [tr[0].id, id(t.l1), j]);
          } else {
            await client.query('INSERT INTO trades(category_id,name,l1_emp_id,sort_order) VALUES($1,$2,$3,$4)',
              [catId, t.name, id(t.l1), j]);
          }
        }
      }
    }

    console.log('→ Seeding outpass approvers…');
    for (let i = 0; i < (cfg.outpass_approvers || []).length; i++) {
      const a = cfg.outpass_approvers[i];
      const { rowCount } = await client.query('SELECT 1 FROM outpass_approvers WHERE label=$1', [a.label]);
      if (!rowCount) await client.query(
        'INSERT INTO outpass_approvers(label,emp_id,sort_order) VALUES($1,$2,$3)', [a.label, id(a.emp_no), i]);
    }

    console.log('→ Seeding expense policy defaults…');
    const policyDefaults = {
      rate_bike: 3.5, rate_car: 5,
      cat1_food: 750, cat1_accom: 1500,
      cat2_food: 500, cat2_accom: 1000,
    };
    for (const [k, v] of Object.entries(policyDefaults)) {
      await client.query(
        `INSERT INTO expense_policy(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING`, [k, v]);
    }

    console.log('✓ Seed complete.');
    console.log(`  Default login password: ${DEFAULT_PASSWORD} (must reset on first login).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
