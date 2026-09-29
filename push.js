// push.js — Web Push notifications (VAPID) for מוקד אחזקה
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const db = require("./db");

const VAPID_FILE = path.join(__dirname, "data", "vapid.json");

function loadOrCreateVapidKeys() {
  // 1) explicit env vars always win (lets you pin stable keys across redeploys, e.g. on Render)
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  // 2) previously-generated keys on disk (same folder as the SQLite DB — same backup/persistence story)
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
      if (saved.publicKey && saved.privateKey) return saved;
    }
  } catch (e) { /* fall through to generating new ones */ }
  // 3) generate once and persist
  const keys = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  } catch (e) {
    console.warn("⚠️  לא הצלחתי לשמור מפתחות VAPID לקובץ — הם ייווצרו מחדש בכל הפעלה, מה שינתק מנויי התראות קיימים.");
  }
  return keys;
}

const VAPID_KEYS = loadOrCreateVapidKeys();
webpush.setVapidDetails("mailto:no-reply@moked-achzaka.local", VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

function getPublicKey() {
  return VAPID_KEYS.publicKey;
}

function saveSubscription(workerId, sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
  db.prepare(`
    INSERT INTO push_subscriptions (worker_id, endpoint, p256dh, auth, created_at)
    VALUES (@worker_id, @endpoint, @p256dh, @auth, @created_at)
    ON CONFLICT(endpoint) DO UPDATE SET worker_id = excluded.worker_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run({
    worker_id: workerId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
    created_at: new Date().toISOString()
  });
  return true;
}

function removeSubscriptionByEndpoint(endpoint) {
  if (!endpoint) return;
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

function hasSubscription(workerId) {
  const row = db.prepare("SELECT COUNT(*) c FROM push_subscriptions WHERE worker_id = ?").get(workerId);
  return row.c > 0;
}

// Sends `payload` (plain object: {title, body, url, tag}) to every worker who can be assigned tasks
// (manager + internal worker accounts — not external suppliers, who have no login) and has at least
// one registered device. Invalid/expired subscriptions are pruned automatically.
async function notifyInternalTeam(payload) {
  const subs = db.prepare(`
    SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN workers w ON w.id = ps.worker_id
    WHERE w.kind IN ('manager','worker')
  `).all();

  console.log(`📣 notifyInternalTeam: found ${subs.length} subscription(s) to send to`);

  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    const pushSubscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(pushSubscription, body);
      console.log("✅ push sent OK to endpoint:", s.endpoint && s.endpoint.slice(0, 60));
    } catch (err) {
      // 404/410 = the push service says this subscription is gone (uninstalled, expired, etc.) — clean it up
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
      } else {
        console.warn("⚠️  שליחת התראת דחיפה נכשלה:", err && err.message,
          "| statusCode:", err && err.statusCode,
          "| body:", err && err.body,
          "| endpoint:", s.endpoint && s.endpoint.slice(0, 60));
      }
    }
  }));
}

module.exports = { getPublicKey, saveSubscription, removeSubscriptionByEndpoint, hasSubscription, notifyInternalTeam };
