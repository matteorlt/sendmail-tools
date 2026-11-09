// SendMail Tools — serveur local de campagnes d'emails de prospection.
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

// ---------------------------------------------------------------------------
// Base de données
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'sendmail.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'drip',          -- drip = long terme, burst = court terme
    daily_limit INTEGER NOT NULL DEFAULT 50,
    delay_seconds INTEGER NOT NULL DEFAULT 60,
    window_start TEXT NOT NULL DEFAULT '09:00',
    window_end TEXT NOT NULL DEFAULT '18:00',
    days TEXT NOT NULL DEFAULT '1,2,3,4,5',
    unsubscribe_footer INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',       -- draft | running | paused | done
    columns TEXT NOT NULL DEFAULT '[]',
    email_column TEXT,
    next_send_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | failed | skipped
    error TEXT,
    sent_at INTEGER,
    token TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_rec_campaign ON recipients(campaign_id, status);
  CREATE INDEX IF NOT EXISTS idx_rec_sent ON recipients(sent_at);
  CREATE TABLE IF NOT EXISTS unsubscribes (email TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL);
`);
db.exec('PRAGMA foreign_keys = ON');
try { db.exec('ALTER TABLE campaigns ADD COLUMN import_stats TEXT'); } catch { /* colonne déjà présente */ }

const SETTINGS_DEFAULTS = {
  smtp_host: '', smtp_port: '587', smtp_secure: '0', smtp_user: '', smtp_pass: '',
  from_name: '', from_email: '', reply_to: '', base_url: '', global_daily_limit: '0',
  warmup_skip: '0',
  // Internes (non modifiables depuis le formulaire)
  warmup_start: '', blocked_until: '0', blocked_reason: '',
};
const INTERNAL_SETTINGS = new Set(['warmup_start', 'blocked_until', 'blocked_reason']);

function getSettings() {
  const s = { ...SETTINGS_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) s[row.key] = row.value;
  return s;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
function saveSettings(obj) {
  const before = getSettings();
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (obj[key] === undefined || INTERNAL_SETTINGS.has(key)) continue;
    if (key === 'smtp_pass' && obj[key] === '********') continue; // mot de passe inchangé
    setSetting(key, String(obj[key]).trim());
  }
  // Nouveau compte d'envoi = nouvelle montée en charge.
  const after = getSettings();
  if ((before.smtp_user || before.from_email) !== (after.smtp_user || after.from_email)) setSetting('warmup_start', '');
  transporter = null;
}

// ---------------------------------------------------------------------------
// Profils de sécurité par fournisseur
// ---------------------------------------------------------------------------
// hardMax : plafond quotidien jamais dépassable (toutes campagnes confondues)
// burst   : envoi en masse autorisé ou non
// minInterval : délai minimum entre deux emails (secondes)
// warmup  : plafond quotidien par semaine d'utilisation (montée en charge)
const PROFILES = {
  gmail: { key: 'gmail', label: 'Gmail personnel', hardMax: 100, burst: false, minInterval: 120, warmup: [20, 40, 70, 100] },
  outlook: { key: 'outlook', label: 'Outlook.com / Hotmail', hardMax: 100, burst: false, minInterval: 120, warmup: [20, 40, 70, 100] },
  workspace: { key: 'workspace', label: 'Google Workspace', hardMax: 500, burst: true, minInterval: 5, warmup: [30, 60, 120, 250, 500] },
  m365: { key: 'm365', label: 'Microsoft 365', hardMax: 500, burst: true, minInterval: 5, warmup: [30, 60, 120, 250, 500] },
  other: { key: 'other', label: 'Autre serveur SMTP', hardMax: 0, burst: true, minInterval: 2, warmup: null },
};

function getProfile(s) {
  const host = (s.smtp_host || '').toLowerCase();
  const account = (s.smtp_user || s.from_email || '').toLowerCase();
  if (/gmail|google/.test(host)) return /@(gmail|googlemail)\.com$/.test(account) ? PROFILES.gmail : PROFILES.workspace;
  if (/office365|outlook|hotmail|live\.com/.test(host)) return /@(outlook|hotmail|live|msn)\.[a-z.]+$/.test(account) ? PROFILES.outlook : PROFILES.m365;
  return PROFILES.other;
}

function warmupInfo(s, p = getProfile(s)) {
  if (!p.warmup) return null;
  if (s.warmup_skip === '1') return { skipped: true, cap: p.hardMax };
  const start = Number(s.warmup_start) || 0;
  const weeks = start ? Math.floor((startOfDay() - startOfDay(new Date(start))) / (7 * 86400000)) : 0;
  const idx = Math.min(weeks, p.warmup.length - 1);
  return { skipped: false, week: idx + 1, cap: p.warmup[idx], next: p.warmup[idx + 1] || null, started: !!start };
}

// Nombre maximum d'emails autorisés aujourd'hui (0 = illimité).
function dailyCap(s) {
  const p = getProfile(s);
  const caps = [];
  if (p.hardMax) caps.push(p.hardMax);
  const w = warmupInfo(s, p);
  if (w) caps.push(w.cap);
  const g = Number(s.global_daily_limit) || 0;
  if (g) caps.push(g);
  return caps.length ? Math.min(...caps) : 0;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}$/i;
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// Remplace {{Colonne}} ou {{Colonne|valeur par défaut}} (insensible à la casse et aux accents).
function renderTemplate(tpl, data, escape) {
  const map = {};
  for (const [k, v] of Object.entries(data)) map[norm(k)] = v;
  return tpl.replace(/\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback) => {
    let v = map[norm(key)];
    if (v === undefined || v === null || String(v).trim() === '') v = fallback ?? '';
    return escape ? escapeHtml(v) : String(v);
  });
}

function buildEmail(campaign, recipient, settings) {
  const data = { ...JSON.parse(recipient.data || '{}'), email: recipient.email };
  const base = (settings.base_url || '').replace(/\/+$/, '');
  const unsubUrl = base ? `${base}/u/${recipient.token}` : '';
  data.unsubscribe_url = unsubUrl;

  const body = campaign.body || '';
  const isHtml = /<\/?(p|div|br|a|b|strong|i|em|u|ul|ol|li|span|table|tr|td|h[1-6]|img|font|hr)\b[^>]*>/i.test(body);
  const hasBlocks = /<(p|br|div|table|ul|ol|h[1-6])\b/i.test(body);
  // HTML « léger » (juste du gras, des liens…) : on garde les retours à la ligne.
  const htmlTpl = isHtml ? (hasBlocks ? body : body.replace(/\r?\n/g, '<br>\n')) : escapeHtml(body).replace(/\r?\n/g, '<br>\n');
  let html = renderTemplate(htmlTpl, data, true);
  let text = renderTemplate(body, data, false);
  if (isHtml) text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

  // Mention de désinscription toujours présente (sauf si le message en contient déjà une).
  const hasOwnUnsub = /unsubscribe_url/i.test(body) || /\bSTOP\b|d[ée]sinscri/i.test(body);
  if (!hasOwnUnsub) {
    if (unsubUrl) {
      html += `<br><br><span style="font-size:12px;color:#888">Vous ne souhaitez plus recevoir mes emails ? <a href="${escapeHtml(unsubUrl)}" style="color:#888">Se désinscrire</a></span>`;
      text += `\n\n--\nVous ne souhaitez plus recevoir mes emails ? Désinscription : ${unsubUrl}`;
    } else {
      html += `<br><br><span style="font-size:12px;color:#888">Vous ne souhaitez plus recevoir mes emails ? Répondez simplement « STOP ».</span>`;
      text += `\n\n--\nVous ne souhaitez plus recevoir mes emails ? Répondez simplement « STOP ».`;
    }
  }

  const subject = renderTemplate(campaign.subject || '', data, false).replace(/[\r\n]+/g, ' ');
  return { to: recipient.email, subject, html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${html}</div>`, text, unsubUrl };
}

let transporter = null;
function getTransporter(settings) {
  if (!settings.smtp_host) throw Object.assign(new Error('Serveur SMTP non configuré (onglet Paramètres).'), { code: 'NOCONFIG' });
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: Number(settings.smtp_port) || 587,
      secure: settings.smtp_secure === '1',
      auth: settings.smtp_user ? { user: settings.smtp_user, pass: settings.smtp_pass } : undefined,
      pool: true,
      maxConnections: 1,
    });
  }
  return transporter;
}

async function sendMail(email, settings) {
  const from = settings.from_name ? `"${settings.from_name.replace(/"/g, '')}" <${settings.from_email}>` : settings.from_email;
  const headers = {};
  if (email.unsubUrl) {
    headers['List-Unsubscribe'] = `<${email.unsubUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return getTransporter(settings).sendMail({
    from, to: email.to, subject: email.subject, html: email.html, text: email.text,
    replyTo: settings.reply_to || undefined, headers,
  });
}

// ---------------------------------------------------------------------------
// Lecture des fichiers Excel / CSV
// ---------------------------------------------------------------------------
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toLocaleDateString('fr-FR');
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('').trim();
    if (v.text !== undefined) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '').trim();
    if (v.error) return '';
    return '';
  }
  return String(v).trim();
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

async function readSpreadsheet(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  let rows;
  if (ext === '.csv' || ext === '.txt') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer); }
    catch { text = new TextDecoder('windows-1252').decode(file.buffer); } // CSV exporté par Excel FR
    rows = parseCsv(text);
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
    if (!ws) throw new Error('Le fichier Excel ne contient aucune feuille.');
    rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(r.getCell(c).value));
      rows.push(vals);
    });
  } else {
    throw new Error('Format non supporté. Utilisez un fichier .xlsx ou .csv (pour un ancien .xls : Fichier > Enregistrer sous > .xlsx).');
  }
  rows = rows.filter((r) => r.some((c) => c !== ''));
  if (rows.length < 2) throw new Error('Le fichier doit contenir une ligne d\'en-têtes et au moins une ligne de données.');

  const seen = {};
  const headers = rows[0].map((h, i) => {
    let name = h || `Colonne ${i + 1}`;
    if (seen[name]) name = `${name} (${++seen[name]})`; else seen[name] = 1;
    return name;
  });
  const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, records };
}

function detectEmailColumn(headers, records) {
  const byName = headers.find((h) => /e-?mail|courriel|mail/i.test(norm(h)));
  if (byName) return byName;
  let best = null; let bestScore = 0;
  for (const h of headers) {
    const score = records.slice(0, 50).filter((r) => EMAIL_RE.test(r[h])).length;
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

const ROLE_RE = /^(contact|info|infos|hello|bonjour|admin|support|sales|commercial|accueil|direction|compta|comptabilite|rh|jobs|recrutement|noreply|no-reply|webmaster|marketing|service|secretariat|office|mail)@/i;

// ---------------------------------------------------------------------------
// Vérifications avant envoi : « block » empêche le lancement, « warn » alerte.
// ---------------------------------------------------------------------------
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc|rb\.gy|lnkd\.in)\//i;
const SPAM_WORDS = ['gratuit', 'offre exceptionnelle', 'offre speciale', 'urgent', 'promo', 'cliquez ici', '100%', 'gagnez', 'remise', 'garanti',
  'sans engagement', 'meilleur prix', 'prix imbattable', 'derniere chance', 'felicitations', 'argent facile', 'sans frais',
  'satisfait ou rembourse', 'credit', 'casino', 'bitcoin', 'investissement', 'opportunite unique', 'ne ratez pas', 'a saisir'];

function checkCampaign(c, s) {
  const p = getProfile(s);
  const block = []; const warn = [];
  const subject = c.subject || ''; const body = c.body || '';
  const textOnly = (str) => str.replace(/<[^>]+>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');
  const plainNorm = norm(textOnly(`${subject} ${body}`));

  // --- Bloquant (risque élevé pour la boîte mail)
  const blockedUntil = Number(s.blocked_until) || 0;
  if (blockedUntil > Date.now()) {
    block.push(`Votre fournisseur a signalé une limite d'envoi (${s.blocked_reason || 'quota atteint'}). Envois suspendus jusqu'au ${new Date(blockedUntil).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} pour protéger votre compte.`);
  }
  if (c.mode === 'burst' && !p.burst) {
    block.push(`L'envoi en masse (court terme) est désactivé avec ${p.label} : c'est la première cause de blocage du compte. Passez en mode « Long terme ».`);
  }
  if (SHORTENERS.test(body)) {
    block.push('Le message contient un lien raccourci (bit.ly, tinyurl…), l\'un des signaux de spam les plus forts. Mettez le lien complet.');
  }

  // --- Alertes (risque modéré)
  const links = (body.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 1) warn.push(`${links} liens dans le message : gardez-en 1 au maximum (idéalement 0 dans le premier email).`);
  if (/<img\b/i.test(body)) warn.push('Le message contient une image : les emails de prospection avec images arrivent plus souvent en spam.');
  const tags = (body.match(/<[a-z][^>]*>/gi) || []).length;
  if (/style=|<font|<table|color:/i.test(body) || tags > 15) warn.push('Mise en forme HTML chargée : un email en texte simple ressemble plus à un vrai message et passe mieux les filtres.');
  const found = SPAM_WORDS.filter((w) => plainNorm.includes(w));
  if (found.length) warn.push(`Mots souvent filtrés comme spam : « ${found.join(' », « ')} ».`);
  if (/!/.test(subject)) warn.push('Évitez les points d\'exclamation dans l\'objet.');
  if ((textOnly(subject).match(/\b[A-ZÀ-Ý]{4,}\b/g) || []).length) warn.push('Évitez les MOTS EN MAJUSCULES dans l\'objet.');
  if (subject.length > 70) warn.push('Objet trop long : visez moins de 50 caractères.');
  if (/^\s*(re|tr|fwd?)\s*:/i.test(subject)) warn.push('Un faux « RE: » ou « TR: » dans l\'objet est trompeur et fait grimper les signalements en spam.');
  if (subject.trim() && body.trim() && !/\{\{/.test(subject + body)) warn.push('Aucune variable de personnalisation ({{Prénom}}, {{Entreprise}}…) : des emails tous identiques sont repérés plus facilement.');
  const words = textOnly(body).split(/\s+/).filter(Boolean).length;
  if (words > 200) warn.push(`Message long (${words} mots) : visez 50 à 120 mots.`);
  const letters = textOnly(body).replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length > 40 && (letters.match(/[A-ZÀ-Ý]/g) || []).length / letters.length > 0.3) warn.push('Beaucoup de majuscules dans le message.');

  if (c.mode === 'drip') {
    if (toMinutes(c.window_start) < 7 * 60 || toMinutes(c.window_end) > 20 * 60) warn.push('Envois tôt le matin ou tard le soir : restez entre 8h et 19h, comme un humain.');
    if (/[06]/.test(String(c.days))) warn.push('Envois le week-end : ils paraissent automatisés et sont moins lus.');
  }
  const cap = dailyCap(s);
  if (cap && c.mode === 'drip' && c.daily_limit > cap) warn.push(`Vous demandez ${c.daily_limit} emails/jour, mais l'envoi sera limité à ${cap}/jour (toutes campagnes confondues) pour protéger votre compte.`);
  const w = warmupInfo(s, p);
  if (w && w.skipped) warn.push('La montée en charge progressive est désactivée (Paramètres) : risque plus élevé sur un compte qui ne prospecte pas déjà.');

  const st = c.import_stats ? JSON.parse(c.import_stats) : null;
  if (st && st.rows) {
    if (st.invalid / st.rows > 0.05) warn.push(`${Math.round((st.invalid / st.rows) * 100)} % d'adresses invalides dans le dernier fichier : la liste est probablement de mauvaise qualité. Vérifiez-la (Dropcontact, ZeroBounce…) pour éviter les rebonds.`);
    if (st.added && st.role / st.added > 0.3) warn.push(`${Math.round((st.role / st.added) * 100)} % d'adresses génériques (contact@, info@…) : elles sont plus filtrées et moins lues que les adresses nominatives.`);
  }
  return { block, warn };
}

// ---------------------------------------------------------------------------
// Planificateur d'envoi
// ---------------------------------------------------------------------------
const inflight = new Set();
const failStreak = new Map();
const FATAL_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'NOCONFIG', 'ETLS']);
// Messages indiquant que le fournisseur limite / bloque l'envoi.
const THROTTLE_RE = /5\.4\.5|daily (user )?sending (quota|limit)|sending limit|quota exceeded|rate limit|too many (messages|recipients|connections|login)|try again later|temporarily (rejected|deferred|blocked|suspended)|4\.7\.[0-9]+|5\.7\.0 .*(unusual|suspicious)|account (is )?(disabled|suspended)/i;

function campaignInterval(c, s) {
  const p = getProfile(s);
  const delay = Math.max(p.minInterval, c.delay_seconds || 1);
  if (c.mode !== 'drip') return delay;
  // Long terme : on étale automatiquement les envois sur la plage horaire.
  const cap = dailyCap(s);
  const perDay = Math.max(1, cap ? Math.min(cap, c.daily_limit) : c.daily_limit);
  const windowSec = Math.max(60, (toMinutes(c.window_end) - toMinutes(c.window_start)) * 60);
  return Math.max(delay, Math.floor(windowSec / perDay));
}

function suspendAll(reason) {
  setSetting('blocked_until', Date.now() + 24 * 3600 * 1000);
  setSetting('blocked_reason', reason.slice(0, 200));
  db.prepare("UPDATE campaigns SET status = 'paused', last_error = ? WHERE status = 'running'")
    .run(`Votre fournisseur a signalé une limite d'envoi : toutes les campagnes sont en pause pendant 24 h pour protéger le compte. Détail : ${reason}`);
}

function inSendingWindow(c, now) {
  const days = String(c.days).split(',').filter(Boolean).map(Number);
  if (!days.includes(now.getDay())) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= toMinutes(c.window_start) && m < toMinutes(c.window_end);
}

function sentTodayGlobal() {
  return db.prepare("SELECT COUNT(*) n FROM recipients WHERE status = 'sent' AND sent_at >= ?").get(startOfDay()).n;
}

function pauseCampaign(id, error) {
  db.prepare("UPDATE campaigns SET status = 'paused', last_error = ? WHERE id = ?").run(error, id);
}

async function processCampaign(c, settings) {
  const now = new Date();
  if (!db.prepare("SELECT 1 FROM recipients WHERE campaign_id = ? AND status = 'pending' LIMIT 1").get(c.id)) {
    db.prepare("UPDATE campaigns SET status = 'done', last_error = NULL WHERE id = ?").run(c.id);
    return;
  }
  const checks = checkCampaign(c, settings);
  if (checks.block.length) {
    // Un risque élevé est apparu (ex : fournisseur changé pour Gmail perso) : on arrête.
    if (!(Number(settings.blocked_until) > Date.now())) pauseCampaign(c.id, `Campagne mise en pause : ${checks.block[0]}`);
    return;
  }
  if (c.next_send_at && now.getTime() < c.next_send_at) return;

  if (c.mode === 'drip') {
    if (!inSendingWindow(c, now)) return;
    const sentToday = db.prepare("SELECT COUNT(*) n FROM recipients WHERE campaign_id = ? AND status = 'sent' AND sent_at >= ?").get(c.id, startOfDay(now)).n;
    if (sentToday >= c.daily_limit) return;
  }
  const cap = dailyCap(settings);
  if (cap && sentTodayGlobal() >= cap) return;

  const r = db.prepare("SELECT * FROM recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(c.id);
  if (!r) {
    db.prepare("UPDATE campaigns SET status = 'done', last_error = NULL WHERE id = ?").run(c.id);
    return;
  }
  if (db.prepare('SELECT 1 FROM unsubscribes WHERE email = ?').get(r.email.toLowerCase())) {
    db.prepare("UPDATE recipients SET status = 'skipped', error = 'Désinscrit' WHERE id = ?").run(r.id);
    return;
  }

  inflight.add(c.id);
  try {
    await sendMail(buildEmail(c, r, settings), settings);
    db.prepare("UPDATE recipients SET status = 'sent', error = NULL, sent_at = ? WHERE id = ?").run(Date.now(), r.id);
    if (!settings.warmup_start) { setSetting('warmup_start', Date.now()); settings.warmup_start = String(Date.now()); }
    failStreak.set(c.id, 0);
    db.prepare('UPDATE campaigns SET last_error = NULL WHERE id = ?').run(c.id);
  } catch (err) {
    const msg = err.response || err.message || String(err);
    if (THROTTLE_RE.test(msg) || [421, 450, 451, 454].includes(err.responseCode)) {
      // Le fournisseur freine : continuer ferait bloquer le compte. Tout s'arrête 24 h.
      transporter = null;
      suspendAll(msg);
    } else if (FATAL_CODES.has(err.code)) {
      // Problème de serveur / connexion : on met en pause sans « brûler » le contact.
      transporter = null;
      pauseCampaign(c.id, `Campagne mise en pause : ${msg}`);
    } else {
      db.prepare("UPDATE recipients SET status = 'failed', error = ?, sent_at = ? WHERE id = ?").run(msg, Date.now(), r.id);
      const streak = (failStreak.get(c.id) || 0) + 1;
      failStreak.set(c.id, streak);
      if (streak >= 3) pauseCampaign(c.id, `Campagne mise en pause après 3 échecs consécutifs (trop d'échecs nuit à la réputation du compte). Dernière erreur : ${msg}`);
    }
  } finally {
    const jitter = 0.75 + Math.random() * 0.5; // envois moins « robotiques »
    db.prepare('UPDATE campaigns SET next_send_at = ? WHERE id = ?').run(Date.now() + Math.round(campaignInterval(c, settings) * 1000 * jitter), c.id);
    inflight.delete(c.id);
  }
}

// Une seule instance à la fois : deux serveurs sur la même base enverraient chaque email en double.
const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
function heartbeat() { setSetting('instance_lock', JSON.stringify({ id: INSTANCE_ID, at: Date.now() })); }
{
  const lock = db.prepare("SELECT value FROM settings WHERE key = 'instance_lock'").get();
  const other = lock ? JSON.parse(lock.value) : null;
  if (other && other.id !== INSTANCE_ID && Date.now() - other.at < 5000) {
    console.error('\n  SendMail Tools est déjà lancé (une autre fenêtre est ouverte). Fermez-la avant d\'en relancer une.\n');
    process.exit(1);
  }
  heartbeat();
}

setInterval(() => {
  heartbeat();
  let campaigns;
  try { campaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all(); } catch { return; }
  if (!campaigns.length) return;
  const settings = getSettings();
  for (const c of campaigns) {
    if (inflight.has(c.id)) continue;
    processCampaign(c, settings).catch((e) => console.error('Erreur planificateur', e));
  }
}, 1000);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Lien de désinscription : public (même si un mot de passe protège l'appli).
function unsubscribePage(title, message, form) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{font-family:system-ui,Arial,sans-serif;background:#f4f5f7;display:grid;place-items:center;min-height:100vh;margin:0}
  .box{background:#fff;padding:32px;border-radius:12px;max-width:420px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
  button{background:#111;color:#fff;border:0;padding:10px 20px;border-radius:8px;font-size:15px;cursor:pointer}</style></head>
  <body><div class="box"><h2>${title}</h2><p>${message}</p>${form || ''}</div></body></html>`;
}
app.get('/u/:token', (req, res) => {
  const r = db.prepare('SELECT email FROM recipients WHERE token = ?').get(req.params.token);
  if (!r) return res.status(404).send(unsubscribePage('Lien invalide', 'Ce lien de désinscription n\'est pas valide.'));
  res.send(unsubscribePage('Se désinscrire', `Ne plus recevoir d'emails à l'adresse <b>${escapeHtml(r.email)}</b> ?`,
    `<form method="post"><button type="submit">Confirmer la désinscription</button></form>`));
});
app.post('/u/:token', (req, res) => {
  const r = db.prepare('SELECT email FROM recipients WHERE token = ?').get(req.params.token);
  if (!r) return res.status(404).send(unsubscribePage('Lien invalide', 'Ce lien de désinscription n\'est pas valide.'));
  db.prepare('INSERT OR IGNORE INTO unsubscribes(email, reason, created_at) VALUES(?, ?, ?)').run(r.email.toLowerCase(), 'Lien de désinscription', Date.now());
  db.prepare("UPDATE recipients SET status = 'skipped', error = 'Désinscrit' WHERE lower(email) = ? AND status = 'pending'").run(r.email.toLowerCase());
  res.send(unsubscribePage('C\'est noté', 'Vous ne recevrez plus d\'emails de notre part.'));
});

// Mot de passe optionnel (variable d'environnement APP_PASSWORD).
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    const ok = pass.length === APP_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(APP_PASSWORD));
    if (ok) return next();
    res.set('WWW-Authenticate', 'Basic realm="SendMail Tools"').status(401).send('Authentification requise');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

function campaignStats(id) {
  const stats = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0, sent_today: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) n FROM recipients WHERE campaign_id = ? GROUP BY status').all(id)) {
    stats[row.status] = row.n; stats.total += row.n;
  }
  stats.sent_today = db.prepare("SELECT COUNT(*) n FROM recipients WHERE campaign_id = ? AND status = 'sent' AND sent_at >= ?").get(id, startOfDay()).n;
  return stats;
}
function getCampaign(id) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!c) throw new Error('Campagne introuvable');
  return { ...c, columns: JSON.parse(c.columns || '[]'), stats: campaignStats(c.id), checks: checkCampaign(c, getSettings()) };
}

// --- Paramètres
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({ ...s, smtp_pass: s.smtp_pass ? '********' : '' });
});
app.put('/api/settings', wrap((req, res) => { saveSettings(req.body); res.json({ ok: true }); }));
app.post('/api/settings/test', wrap(async (req, res) => {
  const s = getSettings();
  if (!EMAIL_RE.test(req.body.to || '')) throw new Error('Adresse de test invalide');
  if (!s.from_email) throw new Error('Renseignez l\'adresse d\'expéditeur');
  await getTransporter(s).verify().catch((e) => { transporter = null; throw new Error(`Connexion SMTP impossible : ${e.message}`); });
  await sendMail({ to: req.body.to, subject: 'Test SendMail Tools', text: 'La configuration SMTP fonctionne.', html: '<p>La configuration SMTP fonctionne ✅</p>' }, s);
  res.json({ ok: true });
}));
app.post('/api/settings/unblock', (req, res) => {
  setSetting('blocked_until', '0'); setSetting('blocked_reason', '');
  res.json({ ok: true });
});
app.get('/api/overview', (req, res) => {
  const s = getSettings();
  const p = getProfile(s);
  const blockedUntil = Number(s.blocked_until) || 0;
  res.json({
    sent_today: sentTodayGlobal(),
    daily_cap: dailyCap(s),
    global_daily_limit: Number(s.global_daily_limit) || 0,
    profile: p,
    warmup: warmupInfo(s, p),
    blocked_until: blockedUntil > Date.now() ? blockedUntil : 0,
    blocked_reason: s.blocked_reason,
    smtp_configured: !!s.smtp_host && !!s.from_email,
    base_url: s.base_url,
  });
});

// --- Campagnes
const CAMPAIGN_FIELDS = ['name', 'subject', 'body', 'mode', 'daily_limit', 'delay_seconds', 'window_start', 'window_end', 'days', 'unsubscribe_footer'];
function cleanCampaign(b) {
  const out = {};
  for (const f of CAMPAIGN_FIELDS) if (b[f] !== undefined) out[f] = b[f];
  if (out.mode && !['drip', 'burst'].includes(out.mode)) throw new Error('Mode invalide');
  if (out.daily_limit !== undefined) out.daily_limit = Math.max(1, parseInt(out.daily_limit, 10) || 1);
  if (out.delay_seconds !== undefined) out.delay_seconds = Math.max(1, parseInt(out.delay_seconds, 10) || 1);
  if (out.unsubscribe_footer !== undefined) out.unsubscribe_footer = out.unsubscribe_footer ? 1 : 0;
  for (const t of ['window_start', 'window_end']) if (out[t] !== undefined && !/^\d{2}:\d{2}$/.test(out[t])) throw new Error('Heure invalide (format HH:MM)');
  if (out.days !== undefined) out.days = String(out.days).split(',').filter((d) => /^[0-6]$/.test(d)).join(',');
  return out;
}

app.get('/api/campaigns', (req, res) => {
  const rows = db.prepare('SELECT id FROM campaigns ORDER BY id DESC').all();
  res.json(rows.map((r) => getCampaign(r.id)));
});
app.post('/api/campaigns', wrap((req, res) => {
  const b = cleanCampaign({ name: 'Nouvelle campagne', ...req.body });
  const defaults = b.mode === 'burst' ? { delay_seconds: 3 } : { delay_seconds: 60 };
  const c = { ...defaults, ...b };
  const keys = Object.keys(c);
  const info = db.prepare(`INSERT INTO campaigns(${keys.join(',')}, created_at) VALUES(${keys.map(() => '?').join(',')}, ?)`).run(...keys.map((k) => c[k]), Date.now());
  res.json(getCampaign(info.lastInsertRowid));
}));
app.get('/api/campaigns/:id', wrap((req, res) => res.json(getCampaign(req.params.id))));
app.put('/api/campaigns/:id', wrap((req, res) => {
  getCampaign(req.params.id);
  const b = cleanCampaign(req.body);
  const keys = Object.keys(b);
  if (keys.length) db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => b[k]), req.params.id);
  res.json(getCampaign(req.params.id));
}));
app.delete('/api/campaigns/:id', wrap((req, res) => {
  db.prepare('DELETE FROM recipients WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/campaigns/:id/duplicate', wrap((req, res) => {
  const c = getCampaign(req.params.id);
  const info = db.prepare(`INSERT INTO campaigns(name, subject, body, mode, daily_limit, delay_seconds, window_start, window_end, days, unsubscribe_footer, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`${c.name} (copie)`, c.subject, c.body, c.mode, c.daily_limit, c.delay_seconds, c.window_start, c.window_end, c.days, c.unsubscribe_footer, Date.now());
  res.json(getCampaign(info.lastInsertRowid));
}));

app.post('/api/campaigns/:id/start', wrap((req, res) => {
  const c = getCampaign(req.params.id);
  const s = getSettings();
  if (!s.smtp_host || !s.from_email) throw new Error('Configurez d\'abord le serveur SMTP dans l\'onglet Paramètres.');
  if (!c.subject.trim() || !c.body.trim()) throw new Error('L\'objet et le message sont obligatoires.');
  if (!c.stats.pending) throw new Error('Aucun contact en attente : importez un fichier Excel.');
  if (c.checks.block.length) throw new Error(c.checks.block[0]);
  failStreak.set(c.id, 0);
  db.prepare("UPDATE campaigns SET status = 'running', last_error = NULL, next_send_at = NULL WHERE id = ?").run(c.id);
  res.json(getCampaign(c.id));
}));
app.post('/api/campaigns/:id/pause', wrap((req, res) => {
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'running'").run(req.params.id);
  res.json(getCampaign(req.params.id));
}));
app.post('/api/campaigns/:id/retry-failed', wrap((req, res) => {
  const info = db.prepare("UPDATE recipients SET status = 'pending', error = NULL, sent_at = NULL WHERE campaign_id = ? AND status = 'failed'").run(req.params.id);
  db.prepare("UPDATE campaigns SET status = CASE WHEN status = 'done' THEN 'paused' ELSE status END WHERE id = ?").run(req.params.id);
  res.json({ ...getCampaign(req.params.id), reset: info.changes });
}));

// Import Excel / CSV
app.post('/api/campaigns/:id/import', upload.single('file'), wrap(async (req, res) => {
  const c = getCampaign(req.params.id);
  if (c.status === 'running') throw new Error('Mettez la campagne en pause avant d\'importer des contacts.');
  if (!req.file) throw new Error('Aucun fichier reçu');
  const { headers, records } = await readSpreadsheet(req.file);
  const emailCol = (req.body.email_column && headers.includes(req.body.email_column)) ? req.body.email_column : detectEmailColumn(headers, records);
  if (!emailCol) throw new Error('Impossible de trouver la colonne des emails. Nommez-la « Email ».');

  const replace = req.body.mode === 'replace';
  const unsub = new Set(db.prepare('SELECT email FROM unsubscribes').all().map((r) => r.email));
  const existing = new Set(replace ? [] : db.prepare('SELECT lower(email) e FROM recipients WHERE campaign_id = ?').all(c.id).map((r) => r.e));
  const result = { added: 0, duplicates: 0, invalid: 0, unsubscribed: 0, invalid_samples: [] };

  db.exec('BEGIN');
  try {
    if (replace) db.prepare('DELETE FROM recipients WHERE campaign_id = ?').run(c.id);
    const insert = db.prepare('INSERT INTO recipients(campaign_id, email, data, token) VALUES(?, ?, ?, ?)');
    for (const rec of records) {
      const email = String(rec[emailCol] || '').replace(/^mailto:/i, '').trim();
      const key = email.toLowerCase();
      if (!EMAIL_RE.test(email)) { result.invalid++; if (result.invalid_samples.length < 5) result.invalid_samples.push(email || '(vide)'); continue; }
      if (existing.has(key)) { result.duplicates++; continue; }
      if (unsub.has(key)) { result.unsubscribed++; continue; }
      existing.add(key);
      insert.run(c.id, email, JSON.stringify(rec), crypto.randomBytes(16).toString('hex'));
      result.added++;
      if (ROLE_RE.test(email)) result.role = (result.role || 0) + 1;
    }
    const cols = replace ? headers : [...new Set([...c.columns, ...headers])];
    const importStats = JSON.stringify({ rows: records.length, invalid: result.invalid, added: result.added, role: result.role || 0 });
    db.prepare("UPDATE campaigns SET columns = ?, email_column = ?, import_stats = ?, status = CASE WHEN status = 'done' THEN 'paused' ELSE status END WHERE id = ?").run(JSON.stringify(cols), emailCol, importStats, c.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ...result, email_column: emailCol, headers, campaign: getCampaign(c.id) });
}));

app.get('/api/campaigns/:id/recipients', wrap((req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  const where = ['campaign_id = ?']; const params = [req.params.id];
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(email LIKE ? OR data LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM recipients WHERE ${w}`).get(...params).n;
  const rows = db.prepare(`SELECT id, email, data, status, error, sent_at FROM recipients WHERE ${w} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ total, rows: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })) });
}));
app.delete('/api/campaigns/:id/recipients', wrap((req, res) => {
  const c = getCampaign(req.params.id);
  if (c.status === 'running') throw new Error('Mettez la campagne en pause d\'abord.');
  db.prepare('DELETE FROM recipients WHERE campaign_id = ?').run(c.id);
  db.prepare("UPDATE campaigns SET columns = '[]', status = 'draft' WHERE id = ?").run(c.id);
  res.json(getCampaign(c.id));
}));
app.delete('/api/recipients/:rid', wrap((req, res) => {
  db.prepare("DELETE FROM recipients WHERE id = ? AND status != 'sent'").run(req.params.rid);
  res.json({ ok: true });
}));

app.get('/api/campaigns/:id/export.csv', wrap((req, res) => {
  const c = getCampaign(req.params.id);
  const rows = db.prepare('SELECT email, data, status, error, sent_at FROM recipients WHERE campaign_id = ? ORDER BY id').all(c.id);
  const labels = { pending: 'En attente', sent: 'Envoyé', failed: 'Échec', skipped: 'Ignoré' };
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = c.columns.length ? c.columns : ['Email'];
  const lines = [[...cols, 'Statut', 'Envoyé le', 'Erreur'].map(q).join(';')];
  for (const r of rows) {
    const d = JSON.parse(r.data);
    lines.push([...cols.map((h) => d[h] ?? (h === c.email_column ? r.email : '')), labels[r.status], r.sent_at ? new Date(r.sent_at).toLocaleString('fr-FR') : '', r.error || ''].map(q).join(';'));
  }
  const fname = `${c.name.replace(/[^\w\- ]+/g, '').trim() || 'campagne'}-resultats.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${fname}"`).send('﻿' + lines.join('\r\n'));
}));

// Aperçu (sur le 1er contact, ou des données fictives) et envoi de test
function sampleRecipient(c, index = 0) {
  const r = db.prepare('SELECT * FROM recipients WHERE campaign_id = ? ORDER BY id LIMIT 1 OFFSET ?').get(c.id, index);
  if (r) return r;
  return { email: 'exemple@entreprise.fr', data: JSON.stringify(Object.fromEntries(c.columns.map((h) => [h, `[${h}]`]))), token: 'apercu' };
}
app.post('/api/campaigns/:id/preview', wrap((req, res) => {
  const c = { ...getCampaign(req.params.id), ...cleanCampaign(req.body || {}) };
  const r = sampleRecipient(c, Math.max(0, parseInt(req.query.index, 10) || 0));
  const e = buildEmail(c, r, getSettings());
  res.json({ to: e.to, subject: e.subject, html: e.html, total: c.stats.total });
}));
app.post('/api/campaigns/:id/test', wrap(async (req, res) => {
  const c = getCampaign(req.params.id);
  if (!EMAIL_RE.test(req.body.to || '')) throw new Error('Adresse de test invalide');
  const s = getSettings();
  const e = buildEmail(c, sampleRecipient(c), s);
  await sendMail({ ...e, to: req.body.to, subject: `[TEST] ${e.subject}` }, s);
  res.json({ ok: true });
}));

// --- Liste de désinscrits (blacklist globale)
app.get('/api/unsubscribes', (req, res) => res.json(db.prepare('SELECT * FROM unsubscribes ORDER BY created_at DESC').all()));
app.post('/api/unsubscribes', wrap((req, res) => {
  const emails = String(req.body.emails || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e));
  const ins = db.prepare('INSERT OR IGNORE INTO unsubscribes(email, reason, created_at) VALUES(?, ?, ?)');
  const skip = db.prepare("UPDATE recipients SET status = 'skipped', error = 'Désinscrit' WHERE lower(email) = ? AND status = 'pending'");
  for (const e of emails) { ins.run(e, req.body.reason || 'Ajout manuel', Date.now()); skip.run(e); }
  res.json({ added: emails.length });
}));
app.delete('/api/unsubscribes/:email', wrap((req, res) => {
  db.prepare('DELETE FROM unsubscribes WHERE email = ?').run(req.params.email.toLowerCase());
  res.json({ ok: true });
}));

app.listen(PORT, HOST, () => {
  console.log(`\n  SendMail Tools est prêt → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `\n  Le port ${PORT} est déjà utilisé (SendMail Tools est peut-être déjà lancé).\n` : e);
  process.exit(1);
});
