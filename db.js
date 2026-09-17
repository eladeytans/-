// db.js — SQLite schema + seed data for מוקד אחזקה
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data", "app.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('manager','worker','vacant','supplier')),
      active INTEGER NOT NULL DEFAULT 1,
      color TEXT,
      username TEXT UNIQUE,
      password_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      desc TEXT,
      department TEXT NOT NULL,
      reporter TEXT NOT NULL,
      equipment TEXT,
      priority TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'חדש',
      assigned_to TEXT,
      due_date TEXT,
      cost REAL,
      invoice_number TEXT,
      dept_unseen_update INTEGER NOT NULL DEFAULT 0,
      last_updated_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      by_name TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('image','video')),
      url TEXT NOT NULL,
      name TEXT
    );
  `);
}

function seedIfEmpty() {
  const workerCount = db.prepare("SELECT COUNT(*) AS c FROM workers").get().c;
  if (workerCount > 0) return; // already seeded

  const insertDept = db.prepare("INSERT INTO departments (name) VALUES (?)");
  ["מפעל קצפות", "מפעל מוצרים ללא גלוטן", "מחסן לוגיסטי", "אבטחת איכות", "משרדים"].forEach(d => insertDept.run(d));

  const insertEquip = db.prepare("INSERT INTO equipment (name) VALUES (?)");
  ["קו לחמניות", "קו בורקס", "מיקסר", "חדר קירור בתהליך", "מטמפררת"].forEach(e => insertEquip.run(e));

  const insertWorker = db.prepare(`
    INSERT INTO workers (id, name, role, kind, active, color, username, password_hash)
    VALUES (@id, @name, @role, @kind, @active, @color, @username, @password_hash)
  `);
  const workers = [
    { id: "w1", name: "יוסי", role: "מנהל אחזקה", kind: "manager", active: 1, color: "var(--series-1)", username: "yossi" },
    { id: "w2", name: "מוחמד", role: "עוזר אחזקה", kind: "worker", active: 1, color: "var(--series-2)", username: "mohamed" },
    { id: "w3", name: "עובד אחזקה 3", role: "עוזר אחזקה (שם לעדכון)", kind: "worker", active: 1, color: "var(--series-3)", username: "worker3" },
    { id: "w4", name: "— תקן פנוי —", role: "עוזר אחזקה (תקן פתוח)", kind: "vacant", active: 0, color: "var(--series-4)", username: null },
    { id: "w6", name: "עובד אחזקה 4", role: "עוזר אחזקה (שם לעדכון)", kind: "worker", active: 1, color: "var(--series-6)", username: "worker4" },
    { id: "w5", name: "חברת קירור קר-טק", role: "ספק חיצוני — מיזוג ומקררים", kind: "supplier", active: 1, color: "var(--series-5)", username: null }
  ];
  workers.forEach(w => {
    const password_hash = w.username ? bcrypt.hashSync(w.username + "123", 10) : null; // default password = username + "123"
    insertWorker.run({ ...w, password_hash });
  });

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, title, desc, department, reporter, equipment, priority, status, assigned_to, due_date, cost, invoice_number, dept_unseen_update, last_updated_at, created_at)
    VALUES (@id, @title, @desc, @department, @reporter, @equipment, @priority, @status, @assigned_to, @due_date, @cost, @invoice_number, 0, NULL, @created_at)
  `);
  const insertNote = db.prepare("INSERT INTO notes (task_id, text, by_name, at) VALUES (?, ?, ?, ?)");

  function daysAgoIso(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }
  function daysFromNowIso(n) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d.toISOString();
  }

  const seeds = [
    { id: "t1", title: "דליפת שמן ממכונת מילוי 2", desc: "שמן מטפטף מתחת למכונת המילוי, יש סיכון החלקה.", department: "מפעל קצפות", reporter: "רונית לוי", equipment: "קו בורקס", priority: "שבר/עוצר עבודה", status: "בטיפול", assigned_to: "w1", daysAgo: 2, dueIn: -1,
      notes: [{ text: "הוזמן חלק חילוף, אמור להגיע מחר.", by: "יוסי", daysAgo: 1 }] },
    { id: "t2", title: "מזגן לא מקרר במחלקת אריזה", desc: "החום עולה במהלך היום, עובדים מתלוננים.", department: "מפעל מוצרים ללא גלוטן", reporter: "אבי שושן", equipment: null, priority: "לא שבר", status: "חדש", assigned_to: null, daysAgo: 1 },
    { id: "t3", title: "מלגזה מס' 4 משמיעה רעש חריג", desc: "רעש מהמנוע בזמן הרמה, נבדק ע\"י הנהג.", department: "מחסן לוגיסטי", reporter: "משה אזולאי", equipment: null, priority: "שבר/עוצר עבודה", status: "חדש", assigned_to: null, daysAgo: 0, dueIn: 0 },
    { id: "t4", title: "ברז מים דולף בחדר בדיקות", desc: "דליפה קטנה מתחת לכיור.", department: "אבטחת איכות", reporter: "נועה כהן", equipment: null, priority: "לא שבר", status: "חדש", assigned_to: null, daysAgo: 3 },
    { id: "t5", title: "דלת מחסן קרור לא נסגרת הרמטית", desc: "יש חשש לעליית טמפרטורה בקירור.", department: "מחסן לוגיסטי", reporter: "משה אזולאי", equipment: "חדר קירור בתהליך", priority: "שבר/עוצר עבודה", status: "בטיפול", assigned_to: "w2", daysAgo: 4, dueIn: 1 },
    { id: "t6", title: "תאורה כבויה במסדרון הייצור", desc: "שני גופי תאורה לא עובדים.", department: "מפעל קצפות", reporter: "רונית לוי", equipment: null, priority: "לא שבר", status: "הושלם", assigned_to: "w3", daysAgo: 6 },
    { id: "t7", title: "רעד חריג במיקסר התעשייתי", desc: "המכונה רועדת בסיבובים גבוהים, נדרשת בדיקת איזון.", department: "מפעל קצפות", reporter: "דני פרץ", equipment: "מיקסר", priority: "שבר/עוצר עבודה", status: "חדש", assigned_to: null, daysAgo: 0 },
    { id: "t8", title: "מדפסת תוויות תקועה", desc: "תוויות נתקעות כל כמה דקות, מעכב את קו האריזה.", department: "מפעל מוצרים ללא גלוטן", reporter: "אבי שושן", equipment: "קו לחמניות", priority: "לא שבר", status: "בטיפול", assigned_to: "w2", daysAgo: 1 },
    { id: "t9", title: "מצלמת אבטחה לא פעילה בכניסה למחסן", desc: "המצלמה בכניסה הראשית לא משדרת.", department: "אבטחת איכות", reporter: "נועה כהן", equipment: null, priority: "לא שבר", status: "בטיפול", assigned_to: "w5", daysAgo: 8, dueIn: 3, cost: 420, invoice_number: "INV-118" },
    { id: "t10", title: "ריצוף סדוק ליד מכונת האריזה הראשית", desc: "סכנת מעידה, יש לתקן בהקדם.", department: "מפעל מוצרים ללא גלוטן", reporter: "רונית לוי", equipment: null, priority: "שבר/עוצר עבודה", status: "הושלם", assigned_to: "w1", daysAgo: 10 },
    { id: "t11", title: "טמפרטורת השוקולד לא יציבה", desc: "הטמפרינג לא יוצא אחיד, יש חשש לפגם באיכות המוצר.", department: "מפעל קצפות", reporter: "דני פרץ", equipment: "מטמפררת", priority: "שבר/עוצר עבודה", status: "חדש", assigned_to: null, daysAgo: 0 }
  ];

  seeds.forEach(s => {
    insertTask.run({
      id: s.id, title: s.title, desc: s.desc || null, department: s.department, reporter: s.reporter,
      equipment: s.equipment || null, priority: s.priority, status: s.status, assigned_to: s.assigned_to || null,
      due_date: s.dueIn != null ? daysFromNowIso(s.dueIn) : null,
      cost: s.cost != null ? s.cost : null,
      invoice_number: s.invoice_number || null,
      created_at: daysAgoIso(s.daysAgo)
    });
    (s.notes || []).forEach(n => insertNote.run(s.id, n.text, n.by, daysAgoIso(n.daysAgo)));
  });
}

migrate();
seedIfEmpty();

module.exports = db;
