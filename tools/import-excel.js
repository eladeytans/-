// tools/import-excel.js — load the cleaned Excel maintenance log (tasks-clean.json) into the local SQLite DB.
// Usage: node tools/import-excel.js path/to/tasks-clean.json
// Removes the demo seed tasks (t1..t11) first. Safe to re-run: tasks already imported are skipped.
const fs = require("fs");
const path = require("path");
fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "..", "uploads"), { recursive: true });
const db = require("../db");

const file = process.argv[2];
if (!file) { console.error("usage: node tools/import-excel.js tasks-clean.json"); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(file, "utf8"));

const STATUS = { "בוצע": "הושלם", "בטיפול": "בטיפול", "חדש": "חדש", "ממתין": "חדש" };
const workers = db.prepare("SELECT id, name FROM workers").all();
function workerFor(by) {
  if (!by) return null;
  const w = workers.find(w => by.split(/[+/ ]+/)[0] === w.name);
  return w ? w.id : null;
}

const demoIds = Array.from({ length: 11 }, (_, i) => "t" + (i + 1));
const run = db.transaction(() => {
  const del = db.prepare("DELETE FROM tasks WHERE id = ?");
  const removed = demoIds.reduce((n, id) => n + del.run(id).changes, 0);

  const addDept = db.prepare("INSERT OR IGNORE INTO departments (name) VALUES (?)");
  [...new Set(rows.map(r => r.DeptName))].forEach(d => addDept.run(d));

  const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?");
  const ins = db.prepare(`
    INSERT INTO tasks (id, title, desc, department, reporter, equipment, project, priority, status, assigned_to, due_date, cost, invoice_number, dept_unseen_update, last_updated_at, created_at)
    VALUES (@id, @title, @desc, @department, @reporter, @equipment, NULL, 'לא שבר', @status, @assigned_to, NULL, NULL, NULL, 0, NULL, @created_at)`);
  const note = db.prepare("INSERT INTO notes (task_id, text, by_name, at) VALUES (?, ?, ?, ?)");
  let added = 0;
  for (const r of rows) {
    const id = "x" + r.row;
    if (exists.get(id)) continue;
    const created = r.ReportedAt || "2025-01-01T09:00:00Z";
    const desc = [
      r.Description,
      r.Area && "אזור: " + r.Area,
      r.CorrectiveAction && "פעולה מתקנת: " + r.CorrectiveAction,
      r.PerformedBy && 'בוצע ע"י: ' + r.PerformedBy,
      r.WaitingReason && "ממתין: " + r.WaitingReason
    ].filter(Boolean).join("\n");
    ins.run({
      id, title: r.Title, desc: desc || null, department: r.DeptName, reporter: "יבוא מאקסל",
      equipment: r.MachineName || null, status: STATUS[r.Status] || "חדש",
      assigned_to: workerFor(r.PerformedBy), created_at: created
    });
    if (r.Note) note.run(id, r.Note, "אקסל", created);
    added++;
  }
  return { removed, added };
});
const res = run();
const counts = db.prepare("SELECT status, COUNT(*) c FROM tasks GROUP BY status").all();
console.log(`demo tasks removed: ${res.removed}, imported: ${res.added}`);
console.log(counts.map(c => `${c.status}: ${c.c}`).join(", "));
