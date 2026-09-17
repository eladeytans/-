// server.js — מוקד אחזקה API + static frontend
require("dotenv").config({ quiet: true });
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.SESSION_SECRET) {
  console.warn("⚠️  SESSION_SECRET not set — using a random secret for this run only. Set SESSION_SECRET in your environment for production (sessions will invalidate on every restart otherwise).");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 14 } // 14 days
  })
);
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, crypto.randomBytes(16).toString("hex") + ext);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

/* ---------------- auth helpers ---------------- */
function requireAuth(req, res, next) {
  if (!req.session.workerId) return res.status(401).json({ error: "התחברות נדרשת" });
  next();
}
function currentWorker(req) {
  if (!req.session.workerId) return null;
  return db.prepare("SELECT id, name, role, kind FROM workers WHERE id = ?").get(req.session.workerId) || null;
}

/* ---------------- serialization helpers ---------------- */
function serializeWorker(w) {
  return { id: w.id, name: w.name, role: w.role, kind: w.kind, active: !!w.active, color: w.color, hasLogin: !!w.username };
}
function serializeTask(t) {
  const notes = db.prepare("SELECT id, text, by_name AS by, at FROM notes WHERE task_id = ? ORDER BY id ASC").all(t.id);
  const attachments = db.prepare("SELECT id, kind, url, name FROM attachments WHERE task_id = ?").all(t.id);
  return {
    id: t.id,
    title: t.title,
    desc: t.desc,
    department: t.department,
    reporter: t.reporter,
    equipment: t.equipment,
    priority: t.priority,
    status: t.status,
    assignedTo: t.assigned_to,
    dueDate: t.due_date,
    cost: t.cost,
    invoiceNumber: t.invoice_number,
    deptUnseenUpdate: !!t.dept_unseen_update,
    lastUpdatedAt: t.last_updated_at,
    createdAt: t.created_at,
    notes,
    attachments
  };
}
function markUpdated(taskId) {
  db.prepare("UPDATE tasks SET last_updated_at = ?, dept_unseen_update = 1 WHERE id = ?").run(new Date().toISOString(), taskId);
}

/* ================= AUTH ================= */
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "יש להזין שם משתמש וסיסמה" });
  const w = db.prepare("SELECT * FROM workers WHERE username = ?").get(String(username).trim());
  if (!w || !w.password_hash || !bcrypt.compareSync(password, w.password_hash)) {
    return res.status(401).json({ error: "שם משתמש או סיסמה שגויים" });
  }
  req.session.workerId = w.id;
  res.json({ worker: serializeWorker(w) });
});
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/auth/me", (req, res) => {
  res.json({ worker: currentWorker(req) });
});
app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const w = db.prepare("SELECT * FROM workers WHERE id = ?").get(req.session.workerId);
  if (!w.password_hash || !bcrypt.compareSync(currentPassword || "", w.password_hash)) {
    return res.status(401).json({ error: "הסיסמה הנוכחית שגויה" });
  }
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "הסיסמה החדשה קצרה מדי" });
  db.prepare("UPDATE workers SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), w.id);
  res.json({ ok: true });
});

/* ================= STATE (bulk read) ================= */
app.get("/api/state", (req, res) => {
  const departments = db.prepare("SELECT name FROM departments ORDER BY id ASC").all().map(r => r.name);
  const equipment = db.prepare("SELECT name FROM equipment ORDER BY id ASC").all().map(r => r.name);
  const workers = db.prepare("SELECT * FROM workers ORDER BY rowid ASC").all().map(serializeWorker);
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all().map(serializeTask);
  res.json({ departments, equipment, workers, tasks, me: currentWorker(req) });
});

/* ================= TASKS ================= */
// Create a new task (department report — no login required)
app.post("/api/tasks", upload.array("attachments", 10), (req, res) => {
  const b = req.body || {};
  const title = (b.title || "").trim();
  const reporter = (b.reporter || "").trim();
  const department = (b.department || "").trim();
  if (!title || !reporter || !department) return res.status(400).json({ error: "חסרים שדות חובה" });
  if (!req.files || !req.files.length) return res.status(400).json({ error: "יש לצרף לפחות קובץ אחד" });

  const id = "t_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, title, desc, department, reporter, equipment, priority, status, assigned_to, due_date, cost, invoice_number, dept_unseen_update, last_updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'חדש', NULL, ?, NULL, NULL, 0, NULL, ?)
  `).run(id, title, b.desc || null, department, reporter, b.equipment || null, b.priority || "לא שבר", b.dueDate || null, now);

  const insertAtt = db.prepare("INSERT INTO attachments (task_id, kind, url, name) VALUES (?, ?, ?, ?)");
  req.files.forEach(f => {
    const kind = f.mimetype.startsWith("video") ? "video" : "image";
    insertAtt.run(id, kind, "/uploads/" + f.filename, f.originalname);
  });

  res.json({ task: serializeTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)) });
});

// Department self-edit (only while status = חדש) — no login required, mirrors report form
app.put("/api/tasks/:id/report", upload.array("attachments", 10), (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "המשימה לא נמצאה" });
  if (t.status !== "חדש") return res.status(409).json({ error: "אי אפשר לערוך משימה שכבר בטיפול" });

  const b = req.body || {};
  db.prepare(`
    UPDATE tasks SET title=?, desc=?, department=?, reporter=?, equipment=?, priority=?, due_date=? WHERE id=?
  `).run(
    (b.title || t.title).trim(), b.desc ?? t.desc, b.department || t.department, (b.reporter || t.reporter).trim(),
    b.equipment || null, b.priority || t.priority, b.dueDate || null, t.id
  );

  if (b.removeAttachmentIds) {
    const ids = String(b.removeAttachmentIds).split(",").map(s => s.trim()).filter(Boolean);
    ids.forEach(aid => db.prepare("DELETE FROM attachments WHERE id = ? AND task_id = ?").run(aid, t.id));
  }
  if (req.files && req.files.length) {
    const insertAtt = db.prepare("INSERT INTO attachments (task_id, kind, url, name) VALUES (?, ?, ?, ?)");
    req.files.forEach(f => {
      const kind = f.mimetype.startsWith("video") ? "video" : "image";
      insertAtt.run(t.id, kind, "/uploads/" + f.filename, f.originalname);
    });
  }

  res.json({ task: serializeTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id)) });
});

// Department withdraw/cancel — no login required
app.post("/api/tasks/:id/cancel", (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "המשימה לא נמצאה" });
  if (t.status !== "חדש") return res.status(409).json({ error: "אי אפשר לבטל משימה שכבר בטיפול" });
  db.prepare("UPDATE tasks SET status = 'בוטל' WHERE id = ?").run(t.id);
  db.prepare("INSERT INTO notes (task_id, text, by_name, at) VALUES (?, ?, ?, ?)")
    .run(t.id, "הדיווח בוטל על ידי המדווח.", t.reporter, new Date().toISOString());
  res.json({ task: serializeTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id)) });
});

// Manager updates: status / priority / assignedTo / dueDate / cost / invoiceNumber — login required
app.put("/api/tasks/:id/manager", requireAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "המשימה לא נמצאה" });
  const b = req.body || {};
  const fields = {
    status: b.status !== undefined ? b.status : t.status,
    priority: b.priority !== undefined ? b.priority : t.priority,
    assigned_to: b.assignedTo !== undefined ? (b.assignedTo || null) : t.assigned_to,
    due_date: b.dueDate !== undefined ? (b.dueDate || null) : t.due_date,
    cost: b.cost !== undefined ? (b.cost === null ? null : Number(b.cost)) : t.cost,
    invoice_number: b.invoiceNumber !== undefined ? (b.invoiceNumber || null) : t.invoice_number
  };
  // auto-move to "בטיפול" the first time a task gets assigned, mirroring the original prototype's behavior
  if (fields.assigned_to && t.status === "חדש" && b.status === undefined) fields.status = "בטיפול";

  db.prepare(`
    UPDATE tasks SET status=@status, priority=@priority, assigned_to=@assigned_to, due_date=@due_date, cost=@cost, invoice_number=@invoice_number WHERE id=@id
  `).run({ ...fields, id: t.id });

  const notifyFields = ["status", "priority", "assigned_to", "due_date"];
  const changed = notifyFields.some(f => fields[f] !== t[f]);
  if (changed) markUpdated(t.id);

  res.json({ task: serializeTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id)) });
});

// Add a work-log note — login required
app.post("/api/tasks/:id/notes", requireAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "המשימה לא נמצאה" });
  const text = (req.body && req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "טקסט ההערה ריק" });
  const me = currentWorker(req);
  db.prepare("INSERT INTO notes (task_id, text, by_name, at) VALUES (?, ?, ?, ?)")
    .run(t.id, text, me ? me.name : null, new Date().toISOString());
  res.json({ task: serializeTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id)) });
});

// Manager marks department-view as "seen" for a batch of tasks (clears the 🆕 badges)
app.post("/api/tasks/ack-seen", (req, res) => {
  db.prepare("UPDATE tasks SET dept_unseen_update = 0").run();
  res.json({ ok: true });
});

/* ================= WORKERS ================= */
app.post("/api/workers", requireAuth, (req, res) => {
  const b = req.body || {};
  const id = (b.kind === "supplier" ? "s_" : "w_") + crypto.randomBytes(6).toString("hex");
  const colors = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-6)"];
  const count = db.prepare("SELECT COUNT(*) c FROM workers").get().c;
  const color = b.kind === "supplier" ? "var(--series-5)" : colors[count % colors.length];
  db.prepare("INSERT INTO workers (id, name, role, kind, active, color, username, password_hash) VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)")
    .run(id, b.name || (b.kind === "supplier" ? "שם הספק" : "איש צוות חדש"), b.role || (b.kind === "supplier" ? "ספק חיצוני" : "עוזר אחזקה"), b.kind === "supplier" ? "supplier" : "worker", color);
  res.json({ worker: serializeWorker(db.prepare("SELECT * FROM workers WHERE id = ?").get(id)) });
});
app.put("/api/workers/:id", requireAuth, (req, res) => {
  const w = db.prepare("SELECT * FROM workers WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).json({ error: "לא נמצא" });
  const b = req.body || {};
  db.prepare("UPDATE workers SET name = ?, role = ? WHERE id = ?")
    .run((b.name || w.name).trim(), b.role !== undefined ? b.role : w.role, w.id);
  res.json({ worker: serializeWorker(db.prepare("SELECT * FROM workers WHERE id = ?").get(w.id)) });
});
app.delete("/api/workers/:id", requireAuth, (req, res) => {
  const w = db.prepare("SELECT * FROM workers WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).json({ error: "לא נמצא" });
  if (w.kind === "manager") return res.status(400).json({ error: "אי אפשר להסיר את מנהל האחזקה" });
  const assignedCount = db.prepare("SELECT COUNT(*) c FROM tasks WHERE assigned_to = ?").get(w.id).c;
  if (assignedCount > 0) return res.status(409).json({ error: "לא ניתן למחוק — יש לו משימות משויכות" });
  db.prepare("DELETE FROM workers WHERE id = ?").run(w.id);
  res.json({ ok: true });
});

/* ================= DEPARTMENTS / EQUIPMENT ================= */
app.post("/api/departments", requireAuth, (req, res) => {
  const name = ((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "שם ריק" });
  try { db.prepare("INSERT INTO departments (name) VALUES (?)").run(name); } catch (e) { /* already exists */ }
  res.json({ ok: true });
});
app.delete("/api/departments/:name", requireAuth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const used = db.prepare("SELECT COUNT(*) c FROM tasks WHERE department = ?").get(name).c;
  if (used > 0) return res.status(409).json({ error: "לא ניתן להסיר — קיימות משימות מהמחלקה הזו" });
  db.prepare("DELETE FROM departments WHERE name = ?").run(name);
  res.json({ ok: true });
});
app.post("/api/equipment", requireAuth, (req, res) => {
  const name = ((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "שם ריק" });
  try { db.prepare("INSERT INTO equipment (name) VALUES (?)").run(name); } catch (e) { /* already exists */ }
  res.json({ ok: true });
});
app.delete("/api/equipment/:name", requireAuth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const used = db.prepare("SELECT COUNT(*) c FROM tasks WHERE equipment = ?").get(name).c;
  if (used > 0) return res.status(409).json({ error: "לא ניתן להסיר — יש משימות המקושרות לציוד הזה" });
  db.prepare("DELETE FROM equipment WHERE name = ?").run(name);
  res.json({ ok: true });
});

/* ================= fallback to SPA ================= */
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`מוקד אחזקה listening on http://localhost:${PORT}`);
});
