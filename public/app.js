// SendMail Tools — interface (JS sans framework)
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => Number(n || 0).toLocaleString('fr-FR');
const STATUS = { draft: 'Brouillon', running: 'En cours', paused: 'En pause', done: 'Terminée' };
const RSTATUS = { pending: 'En attente', sent: 'Envoyé', failed: 'Échec', skipped: 'Ignoré' };
const DAYS = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mer'], ['4', 'Jeu'], ['5', 'Ven'], ['6', 'Sam'], ['0', 'Dim']];

async function api(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
  const res = await fetch(url, o);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

let timers = [];
function every(ms, fn) { timers.push(setInterval(fn, ms)); }
function clearTimers() { timers.forEach(clearInterval); timers = []; }

function progressBar(s) {
  const t = s.total || 1;
  return `<div class="progress"><div class="p-sent" style="width:${(s.sent / t) * 100}%"></div><div class="p-failed" style="width:${(s.failed / t) * 100}%"></div><div class="p-skipped" style="width:${(s.skipped / t) * 100}%"></div></div>`;
}

function eta(c) {
  const p = c.stats.pending;
  if (!p) return '';
  if (c.mode === 'burst') {
    const sec = p * c.delay_seconds;
    const txt = sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1).replace('.', ',')} h`;
    return `≈ ${txt} pour envoyer les ${fmtN(p)} emails restants`;
  }
  const perWeek = c.daily_limit * Math.max(1, c.days.split(',').filter(Boolean).length);
  const days = Math.ceil(p / c.daily_limit);
  const weeks = p / perWeek;
  return `≈ ${days} jour${days > 1 ? 's' : ''} d'envoi (${weeks < 1 ? 'moins d\'une semaine' : `${weeks.toFixed(1).replace('.', ',')} semaines`}) pour les ${fmtN(p)} emails restants`;
}

let overview = null;
async function refreshQuota() {
  try {
    const o = overview = await api('/api/overview');
    const w = o.warmup;
    $('#quota').innerHTML = `Envoyés aujourd'hui<br><b>${fmtN(o.sent_today)}</b>${o.daily_cap ? ` / ${fmtN(o.daily_cap)} max` : ''}`
      + (o.smtp_configured ? `<br><span>${esc(o.profile.label)}</span>` : '')
      + (w && !w.skipped ? `<br>Montée en charge : semaine ${w.week}` : '')
      + (o.blocked_until ? `<br><br><span style="color:#ff8a8a">⛔ Envois suspendus jusqu'au ${new Date(o.blocked_until).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>` : '')
      + (o.smtp_configured ? '' : '<br><br><a href="#/settings" style="color:#ffb547">⚠️ SMTP non configuré</a>');
  } catch { /* ignore */ }
  return overview;
}

// ---------------------------------------------------------------------------
// Routeur
// ---------------------------------------------------------------------------
function route() {
  clearTimers();
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/c\/(\d+)/);
  $$('.sidebar nav a').forEach((a) => a.classList.toggle('active',
    (a.dataset.nav === 'campaigns' && (h === '/' || m)) || h === `/${a.dataset.nav}`));
  if (m) return viewCampaign(m[1]);
  if (h === '/settings') return viewSettings();
  if (h === '/unsubscribes') return viewUnsubscribes();
  return viewCampaigns();
}
window.addEventListener('hashchange', route);
refreshQuota();
setInterval(refreshQuota, 10000);
route();

// ---------------------------------------------------------------------------
// Liste des campagnes
// ---------------------------------------------------------------------------
async function viewCampaigns() {
  app.innerHTML = `
    <div class="page-head"><h1>Campagnes</h1><div class="spacer"></div>
      <button class="primary" id="new-drip">＋ Campagne long terme</button>
      <button class="primary" id="new-burst">＋ Campagne court terme</button>
    </div>
    <div id="list"></div>`;
  const create = async (mode) => {
    const c = await api('/api/campaigns', { method: 'POST', body: { mode, name: mode === 'drip' ? 'Prospection long terme' : 'Envoi en masse' } });
    location.hash = `#/c/${c.id}`;
  };
  $('#new-drip').onclick = () => create('drip');
  $('#new-burst').onclick = () => create('burst');
  const o = await refreshQuota();
  if (o && !o.profile.burst) {
    $('#new-burst').disabled = true;
    $('#new-burst').title = `Envoi en masse désactivé avec ${o.profile.label} (risque de blocage du compte)`;
  }

  const render = async () => {
    const list = await api('/api/campaigns');
    if (!list.length) {
      $('#list').innerHTML = `<div class="card empty"><div class="big">📭</div><p><b>Aucune campagne pour l'instant</b></p>
        <p>Créez une campagne <b>long terme</b> (ex : 50 emails par jour, étalés sur la journée)<br>ou <b>court terme</b> (ex : 1 000 emails envoyés d'un coup).</p></div>`;
      return;
    }
    $('#list').innerHTML = `<div class="campaigns">${list.map((c) => `
      <div class="card camp-card" data-id="${c.id}">
        <div class="row" style="justify-content:space-between"><div class="title">${esc(c.name)}</div><span class="badge ${c.status}">${STATUS[c.status]}</span></div>
        <div class="muted small">${c.mode === 'drip' ? `🐢 Long terme · ${c.daily_limit}/jour` : `⚡ Court terme · 1 email / ${c.delay_seconds}s`}</div>
        ${progressBar(c.stats)}
        <div class="small muted">${fmtN(c.stats.sent)} envoyés / ${fmtN(c.stats.total)} contacts${c.stats.failed ? ` · <span style="color:var(--red)">${fmtN(c.stats.failed)} échecs</span>` : ''}</div>
        ${c.last_error ? `<div class="small" style="color:var(--red);margin-top:6px">⚠️ ${esc(c.last_error).slice(0, 120)}</div>` : ''}
      </div>`).join('')}</div>`;
    $$('.camp-card').forEach((el) => { el.onclick = () => { location.hash = `#/c/${el.dataset.id}`; }; });
  };
  await render();
  every(5000, render);
}

// ---------------------------------------------------------------------------
// Détail d'une campagne
// ---------------------------------------------------------------------------
async function viewCampaign(id) {
  let c;
  try { c = await api(`/api/campaigns/${id}`); } catch (e) { app.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
  const settings = await api('/api/settings');
  const ov = await refreshQuota();
  const profile = ov ? ov.profile : { burst: true, label: '' };
  const cap = ov ? ov.daily_cap : 0;

  app.innerHTML = `
    <div class="page-head">
      <a href="#/" class="btn ghost">←</a>
      <input class="name-input" id="f-name" type="text" value="${esc(c.name)}">
      <span id="status-badge"></span>
      <span class="save-state" id="save-state"></span>
      <div class="spacer"></div>
      <span id="actions" class="row"></span>
    </div>
    <div id="banner"></div>
    <div class="stats" id="stats"></div>

    <div class="card">
      <h2>1. Contacts <span class="muted small" style="font-weight:400">— importez votre fichier Excel</span></h2>
      <div class="grid2">
        <div>
          <div class="drop" id="drop"><div class="big">📄</div><b>Glissez votre fichier Excel ici</b><br><span class="small">ou cliquez pour le choisir (.xlsx ou .csv)</span></div>
          <input type="file" id="file" accept=".xlsx,.xlsm,.csv,.txt" hidden>
          <div class="row" style="margin-top:10px">
            <label class="check"><input type="radio" name="imode" value="append" checked> Ajouter aux contacts existants</label>
            <label class="check"><input type="radio" name="imode" value="replace"> Remplacer la liste</label>
          </div>
          <div id="import-result"></div>
        </div>
        <div>
          <h3>Colonnes détectées</h3>
          <div class="hint" style="margin-bottom:8px">Chaque colonne devient une variable utilisable dans l'objet et le message. Cliquez pour l'insérer.</div>
          <div class="chips" id="columns"></div>
          <div class="hint" style="margin-top:12px">💡 La première ligne du fichier doit contenir les noms des colonnes (ex : <i>Email, Prénom, Nom, Entreprise, Ville</i>). Les doublons, adresses invalides et désinscrits sont ignorés automatiquement.</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>2. Message</h2>
      <div class="grid2">
        <div>
          <div class="field"><label>Objet</label><input type="text" id="f-subject" value="${esc(c.subject)}" placeholder="Ex : {{Prénom}}, une question sur {{Entreprise}}"></div>
          <div class="field"><label>Message</label>
            <textarea id="f-body" placeholder="Bonjour {{Prénom|}},&#10;&#10;Je me permets de vous contacter car...">${esc(c.body)}</textarea>
            <div class="hint">Variables : <code>{{Prénom}}</code> · valeur par défaut si la cellule est vide : <code>{{Prénom|Madame, Monsieur}}</code> · privilégiez le texte simple.</div>
            <div class="hint">🔒 Une mention de désinscription est ajoutée automatiquement en bas de chaque email (obligatoire et indispensable pour éviter les signalements en spam).</div>
          </div>
        </div>
        <div>
          <div class="row" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0">Aperçu</h3>
            <div class="row" style="gap:4px"><button class="ghost" id="prev-prev">‹</button><span class="small muted" id="prev-idx"></span><button class="ghost" id="prev-next">›</button></div></div>
          <div class="preview"><div class="meta" id="prev-meta"></div><iframe id="prev-frame" sandbox></iframe></div>
          <div class="row" style="margin-top:10px">
            <input type="email" id="test-to" placeholder="votre@email.fr" style="flex:1" value="${esc(localStorage.getItem('testTo') || settings.from_email || '')}">
            <button id="send-test">Envoyer un test</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>3. Rythme d'envoi</h2>
      <div class="modes">
        <div class="mode" data-mode="drip"><div class="t">🐢 Long terme (progressif)</div><div class="small muted">Un nombre fixe d'emails par jour, étalés sur une plage horaire. Idéal pour la prospection et la délivrabilité.</div></div>
        <div class="mode ${profile.burst ? '' : 'disabled'}" data-mode="burst"><div class="t">⚡ Court terme (en masse)</div><div class="small muted">${profile.burst
          ? 'Tous les emails envoyés d\'un coup, avec un court délai entre chaque envoi.'
          : `🔒 Indisponible avec ${esc(profile.label)} : l'envoi en masse fait bloquer le compte.`}</div></div>
      </div>
      <div id="mode-drip">
        <div class="row" style="align-items:flex-start;gap:24px">
          <div class="field"><label>Emails par jour</label><input type="number" id="f-daily" min="1" value="${c.daily_limit}" style="width:120px"></div>
          <div class="field"><label>Plage horaire</label><div class="row" style="gap:6px"><input type="time" id="f-ws" value="${c.window_start}" style="width:120px"> à <input type="time" id="f-we" value="${c.window_end}" style="width:120px"></div></div>
          <div class="field"><label>Jours d'envoi</label><div class="days" id="f-days">${DAYS.map(([v, l]) => `<label><input type="checkbox" value="${v}" ${c.days.split(',').includes(v) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        </div>
        <div class="hint" id="drip-hint"></div>
      </div>
      <div id="mode-burst">
        <div class="field"><label>Délai entre deux emails (secondes)</label><input type="number" id="f-delay" min="1" value="${c.delay_seconds}" style="width:120px">
          <div class="hint">Un délai de 2 à 5 secondes évite d'être bloqué par votre fournisseur. Vérifiez sa limite quotidienne (Gmail : ~500/jour, Google Workspace : ~2 000/jour, Outlook : ~300/jour).</div></div>
      </div>
      <div class="alert info" id="eta" style="margin:8px 0 0"></div>
    </div>

    <div class="card">
      <h2>4. Vérification anti-blocage / anti-spam</h2>
      <div id="checks"></div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <h2 style="margin:0">5. Suivi des envois</h2>
        <div class="row">
          <select id="r-status" style="width:auto"><option value="">Tous les statuts</option>${Object.entries(RSTATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input type="text" id="r-q" placeholder="Rechercher…" style="width:200px">
          <a class="btn" href="/api/campaigns/${c.id}/export.csv">⬇ Exporter</a>
        </div>
      </div>
      <div class="table-wrap" id="r-table"></div>
      <div class="row" style="justify-content:space-between;margin-top:10px"><span class="small muted" id="r-count"></span>
        <div class="row"><button id="r-prev">‹ Précédent</button><button id="r-next">Suivant ›</button></div></div>
    </div>`;

  // ---- état local
  let mode = c.mode;
  let previewIdx = 0;
  let rOffset = 0;
  const R_LIMIT = 50;
  let lastField = $('#f-body');

  const readForm = () => ({
    name: $('#f-name').value.trim() || 'Sans nom',
    subject: $('#f-subject').value,
    body: $('#f-body').value,
    mode,
    daily_limit: Number($('#f-daily').value) || 1,
    delay_seconds: Number($('#f-delay').value) || 1,
    window_start: $('#f-ws').value || '09:00',
    window_end: $('#f-we').value || '18:00',
    days: $$('#f-days input:checked').map((i) => i.value).join(','),
  });
  const effDaily = (f) => (cap ? Math.min(cap, f.daily_limit) : f.daily_limit);

  // ---- en-tête, stats, actions
  function renderHeader() {
    $('#status-badge').innerHTML = `<span class="badge ${c.status}">${STATUS[c.status]}</span>`;
    const s = c.stats;
    $('#stats').innerHTML = [
      [s.total, 'Contacts'], [s.sent, `Envoyés${s.sent_today ? ` (dont ${fmtN(s.sent_today)} aujourd'hui)` : ''}`], [s.pending, 'En attente'], [s.failed, 'Échecs'], [s.skipped, 'Ignorés (désinscrits)'],
    ].map(([n, l]) => `<div class="stat"><div class="n">${fmtN(n)}</div><div class="l">${l}</div></div>`).join('');

    let banner = '';
    if (c.last_error) banner += `<div class="alert error">⚠️ ${esc(c.last_error)}</div>`;
    if (!settings.smtp_host) banner += `<div class="alert warn">Le serveur d'envoi n'est pas configuré. <a href="#/settings">Configurer le SMTP →</a></div>`;
    if (c.status === 'running' && c.mode === 'drip') banner += `<div class="alert info">🐢 Campagne active : les emails partent automatiquement ${c.days.split(',').length === 5 && !c.days.includes('0') && !c.days.includes('6') ? 'du lundi au vendredi' : 'les jours choisis'} entre ${c.window_start} et ${c.window_end}. Laissez l'application ouverte (le serveur doit tourner).</div>`;
    $('#banner').innerHTML = banner;

    const a = [];
    if (c.status === 'running') a.push('<button class="warn" data-act="pause">⏸ Mettre en pause</button>');
    else if (c.stats.pending) a.push(`<button class="success" data-act="start" ${c.checks.block.length ? 'disabled title="Corrigez les points bloquants (section 4)"' : ''}>▶ ${c.status === 'paused' ? 'Reprendre' : 'Lancer la campagne'}</button>`);
    if (c.stats.failed) a.push('<button data-act="retry">↻ Relancer les échecs</button>');
    a.push('<button data-act="dup" title="Dupliquer">⧉</button>');
    a.push('<button class="danger" data-act="del" title="Supprimer">🗑</button>');
    $('#actions').innerHTML = a.join('');
    $$('#actions button').forEach((b) => { b.onclick = () => action(b.dataset.act); });

    $('#columns').innerHTML = c.columns.length
      ? c.columns.map((h) => `<span class="chip ${h === c.email_column ? 'email' : ''}" data-col="${esc(h)}" title="${h === c.email_column ? 'Colonne utilisée pour les adresses email' : 'Insérer la variable'}">${h === c.email_column ? '✉ ' : ''}${esc(h)}</span>`).join('')
      : '<span class="muted small">Aucun fichier importé.</span>';
    $$('#columns .chip').forEach((ch) => { ch.onclick = () => insertVar(ch.dataset.col); });
    const f = readForm();
    $('#eta').textContent = eta({ ...c, ...f, daily_limit: effDaily(f) }) || (c.stats.total ? 'Tous les contacts ont été traités.' : 'Importez des contacts pour voir l\'estimation.');
    renderChecks();
  }

  function renderChecks() {
    const { block, warn } = c.checks;
    let html = '';
    if (block.length) html += `<div class="alert error"><b>⛔ Bloquant — à corriger avant de lancer :</b><ul class="checklist">${block.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
    if (warn.length) html += `<div class="alert warn"><b>⚠️ Risque modéré — conseillé de corriger :</b><ul class="checklist">${warn.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
    if (!block.length && !warn.length) html = '<div class="alert ok">✅ Aucun risque détecté.</div>';
    const w = ov && ov.warmup;
    if (cap) {
      html += `<div class="hint">🔒 ${ov.profile.label} : maximum <b>${fmtN(cap)} emails aujourd'hui</b>, toutes campagnes confondues${w && !w.skipped
        ? ` (montée en charge, semaine ${w.week}${w.next ? ` — passera à ${w.next}/jour la semaine prochaine` : ''})` : ''}. L'outil s'arrête aussi 24 h si le fournisseur signale une limite.</div>`;
    }
    $('#checks').innerHTML = html;
  }

  function renderMode() {
    $$('.mode').forEach((m) => m.classList.toggle('active', m.dataset.mode === mode));
    $('#mode-drip').hidden = mode !== 'drip';
    $('#mode-burst').hidden = mode !== 'burst';
    const f = readForm();
    const [h1, m1] = f.window_start.split(':').map(Number); const [h2, m2] = f.window_end.split(':').map(Number);
    const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
    const perDay = effDaily(f);
    $('#drip-hint').textContent = mins > 0 && perDay
      ? `→ environ 1 email toutes les ${Math.max(1, Math.round(mins / perDay))} min (avec un léger décalage aléatoire pour paraître plus naturel).${perDay < f.daily_limit ? ` Limité à ${perDay}/jour pour l'instant (protection du compte).` : ''}`
      : '⚠️ La plage horaire est invalide.';
    if (cap) $('#f-daily').max = ov.profile.hardMax || '';
    $('#eta').textContent = eta({ ...c, ...f, daily_limit: perDay }) || $('#eta').textContent;
  }

  function insertVar(col) {
    const el = lastField;
    const token = `{{${col}}}`;
    const start = el.selectionStart ?? el.value.length; const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + token + el.value.slice(end);
    el.focus(); el.selectionStart = el.selectionEnd = start + token.length;
    scheduleSave();
  }

  async function action(act) {
    try {
      if (act === 'start' || act === 'pause') {
        await save();
        if (act === 'start' && c.mode === 'burst' && !confirm(`Lancer l'envoi de ${fmtN(c.stats.pending)} emails maintenant ?`)) return;
        c = await api(`/api/campaigns/${c.id}/${act}`, { method: 'POST' });
        toast(act === 'start' ? 'Campagne lancée 🚀' : 'Campagne en pause', 'success');
      } else if (act === 'retry') {
        c = await api(`/api/campaigns/${c.id}/retry-failed`, { method: 'POST' });
        toast(`${c.reset} contact(s) remis en attente. Relancez la campagne.`);
      } else if (act === 'dup') {
        const n = await api(`/api/campaigns/${c.id}/duplicate`, { method: 'POST' });
        location.hash = `#/c/${n.id}`; return;
      } else if (act === 'del') {
        if (!confirm('Supprimer définitivement cette campagne et son historique ?')) return;
        await api(`/api/campaigns/${c.id}`, { method: 'DELETE' });
        location.hash = '#/'; return;
      }
      renderHeader(); loadRecipients();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- sauvegarde automatique
  let saveTimer = null;
  async function save() {
    clearTimeout(saveTimer);
    const fresh = await api(`/api/campaigns/${c.id}`, { method: 'PUT', body: readForm() });
    c = fresh;
    $('#save-state').textContent = '✓ Enregistré';
  }
  function scheduleSave() {
    $('#save-state').textContent = 'Modifications…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await save(); renderHeader(); updatePreview(); } catch (e) { toast(e.message, 'error'); }
    }, 700);
  }
  ['#f-name', '#f-subject', '#f-body', '#f-daily', '#f-delay', '#f-ws', '#f-we'].forEach((s) => $(s).addEventListener('input', () => { renderMode(); scheduleSave(); }));
  $('#f-days').addEventListener('change', () => { renderMode(); scheduleSave(); });
  ['#f-subject', '#f-body'].forEach((s) => $(s).addEventListener('focus', (e) => { lastField = e.target; }));
  $$('.mode').forEach((m) => {
    m.onclick = () => {
      if (m.classList.contains('disabled')) { toast(`Envoi en masse indisponible avec ${profile.label} (risque de blocage du compte).`, 'error'); return; }
      mode = m.dataset.mode; renderMode(); scheduleSave();
    };
  });

  // ---- aperçu
  async function updatePreview() {
    try {
      const p = await api(`/api/campaigns/${c.id}/preview?index=${previewIdx}`, { method: 'POST', body: readForm() });
      $('#prev-meta').innerHTML = `<div><b>À :</b> ${esc(p.to)}</div><div><b>Objet :</b> ${esc(p.subject) || '<span class="muted">(vide)</span>'}</div>`;
      $('#prev-frame').srcdoc = p.html;
      $('#prev-idx').textContent = p.total ? `Contact ${previewIdx + 1} / ${fmtN(p.total)}` : 'Exemple';
    } catch (e) { $('#prev-meta').textContent = e.message; }
  }
  $('#prev-prev').onclick = () => { previewIdx = Math.max(0, previewIdx - 1); updatePreview(); };
  $('#prev-next').onclick = () => { if (previewIdx + 1 < c.stats.total) { previewIdx++; updatePreview(); } };
  $('#send-test').onclick = async () => {
    const to = $('#test-to').value.trim();
    localStorage.setItem('testTo', to);
    const btn = $('#send-test'); btn.disabled = true; btn.textContent = 'Envoi…';
    try { await save(); await api(`/api/campaigns/${c.id}/test`, { method: 'POST', body: { to } }); toast(`Email de test envoyé à ${to}`, 'success'); }
    catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Envoyer un test'; }
  };

  // ---- import
  const drop = $('#drop'); const fileInput = $('#file');
  drop.onclick = () => fileInput.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) doImport(e.dataTransfer.files[0]); };
  fileInput.onchange = () => { if (fileInput.files[0]) doImport(fileInput.files[0]); fileInput.value = ''; };

  async function doImport(file) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', $('input[name=imode]:checked').value);
    $('#import-result').innerHTML = '<p class="muted">Import en cours…</p>';
    try {
      const r = await api(`/api/campaigns/${c.id}/import`, { method: 'POST', body: fd });
      c = r.campaign;
      const skipped = [];
      if (r.duplicates) skipped.push(`${fmtN(r.duplicates)} doublon(s)`);
      if (r.invalid) skipped.push(`${fmtN(r.invalid)} email(s) invalide(s)${r.invalid_samples.length ? ` (ex : ${r.invalid_samples.map(esc).join(', ')})` : ''}`);
      if (r.unsubscribed) skipped.push(`${fmtN(r.unsubscribed)} désinscrit(s)`);
      $('#import-result').innerHTML = `<div class="alert info" style="margin:10px 0 0">✅ <b>${fmtN(r.added)} contact(s) ajouté(s)</b> depuis « ${esc(file.name)} » — colonne email : <b>${esc(r.email_column)}</b>${skipped.length ? `<br>Ignorés : ${skipped.join(' · ')}` : ''}</div>`;
      renderHeader(); updatePreview(); loadRecipients();
    } catch (e) {
      $('#import-result').innerHTML = `<div class="alert error" style="margin:10px 0 0">${esc(e.message)}</div>`;
    }
  }

  // ---- tableau des destinataires
  async function loadRecipients() {
    const qs = new URLSearchParams({ limit: R_LIMIT, offset: rOffset, status: $('#r-status').value, q: $('#r-q').value });
    const { total, rows } = await api(`/api/campaigns/${c.id}/recipients?${qs}`);
    const cols = c.columns.filter((h) => h !== c.email_column).slice(0, 4);
    $('#r-table').innerHTML = rows.length ? `<table><thead><tr><th>Email</th>${cols.map((h) => `<th>${esc(h)}</th>`).join('')}<th>Statut</th><th>Date</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.email)}</td>${cols.map((h) => `<td>${esc(r.data[h])}</td>`).join('')}
        <td><span class="badge ${r.status}">${RSTATUS[r.status]}</span>${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</td>
        <td class="small muted">${r.sent_at ? new Date(r.sent_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : ''}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Aucun contact.</p>';
    $('#r-count').textContent = total ? `${fmtN(rOffset + 1)}–${fmtN(Math.min(rOffset + R_LIMIT, total))} sur ${fmtN(total)}` : '';
    $('#r-prev').disabled = rOffset === 0;
    $('#r-next').disabled = rOffset + R_LIMIT >= total;
  }
  $('#r-status').onchange = () => { rOffset = 0; loadRecipients(); };
  let qTimer; $('#r-q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => { rOffset = 0; loadRecipients(); }, 300); };
  $('#r-prev').onclick = () => { rOffset = Math.max(0, rOffset - R_LIMIT); loadRecipients(); };
  $('#r-next').onclick = () => { rOffset += R_LIMIT; loadRecipients(); };

  renderHeader(); renderMode(); updatePreview(); loadRecipients();

  // Rafraîchissement automatique des compteurs (sans toucher au formulaire en cours d'édition)
  every(4000, async () => {
    try {
      const fresh = await api(`/api/campaigns/${c.id}`);
      const changed = JSON.stringify(fresh.stats) !== JSON.stringify(c.stats) || fresh.status !== c.status || fresh.last_error !== c.last_error
        || JSON.stringify(fresh.checks.block) !== JSON.stringify(c.checks.block);
      c = { ...c, stats: fresh.stats, status: fresh.status, last_error: fresh.last_error, checks: fresh.checks };
      if (changed) { renderHeader(); loadRecipients(); }
    } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Paramètres SMTP
// ---------------------------------------------------------------------------
const PRESETS = {
  gmail: { smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_secure: '0', note: 'Gmail : activez la validation en 2 étapes puis créez un « mot de passe d\'application » (myaccount.google.com/apppasswords). Limite ≈ 500 emails/jour (2 000 avec Google Workspace).' },
  outlook: { smtp_host: 'smtp.office365.com', smtp_port: '587', smtp_secure: '0', note: 'Outlook / Microsoft 365 : le SMTP authentifié doit être activé sur la boîte. Limite ≈ 300 emails/jour (comptes perso), 10 000/jour (Microsoft 365).' },
  ovh: { smtp_host: 'ssl0.ovh.net', smtp_port: '465', smtp_secure: '1', note: 'OVH : utilisez l\'adresse email complète comme identifiant.' },
  ionos: { smtp_host: 'smtp.ionos.fr', smtp_port: '587', smtp_secure: '0', note: 'IONOS : utilisez l\'adresse email complète comme identifiant.' },
  brevo: { smtp_host: 'smtp-relay.brevo.com', smtp_port: '587', smtp_secure: '0', note: 'Brevo (ex-Sendinblue) : identifiant et clé SMTP dans « SMTP & API ». Adapté aux gros volumes (court terme).' },
};

async function viewSettings() {
  const s = await api('/api/settings');
  const o = await refreshQuota();
  const p = o.profile; const w = o.warmup;
  app.innerHTML = `
    <div class="page-head"><h1>Paramètres</h1></div>
    ${o.blocked_until ? `<div class="alert error">⛔ <b>Envois suspendus jusqu'au ${new Date(o.blocked_until).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</b> : votre fournisseur a signalé une limite (${esc(o.blocked_reason)}). Reprendre avant risque de faire suspendre le compte.
      <div style="margin-top:8px"><button class="danger" id="unblock">Débloquer quand même</button></div></div>` : ''}
    ${o.smtp_configured ? `<div class="card">
      <h2>🔒 Protection du compte : ${esc(p.label)}</h2>
      <ul class="checklist">
        ${p.hardMax ? `<li>Maximum absolu : <b>${p.hardMax} emails par jour</b>, toutes campagnes confondues.</li>` : '<li>Pas de plafond imposé : réglez une limite globale ci-dessous selon votre fournisseur.</li>'}
        ${p.burst ? `<li>Envoi en masse autorisé, au minimum ${p.minInterval} s entre deux emails.</li>` : '<li>Envoi en masse (court terme) <b>désactivé</b> : uniquement des envois progressifs, au minimum 2 min entre deux emails.</li>'}
        ${w ? (w.skipped ? '<li>Montée en charge <b>désactivée</b>.</li>' : `<li>Montée en charge : ${p.warmup.map((n, i) => `${i === w.week - 1 ? '<b>' : ''}sem. ${i + 1} → ${n}/jour${i === w.week - 1 ? ' (actuelle)</b>' : ''}`).join(' · ')}${w.started ? '' : ' — démarre au premier envoi'}.</li>`) : ''}
        <li>Arrêt automatique de 24 h si le fournisseur signale une limite, et pause d'une campagne après 3 échecs d'affilée.</li>
        <li>Lien raccourci interdit, mention de désinscription toujours ajoutée.</li>
      </ul>
      ${w ? `<label class="check" style="margin-top:8px"><input type="checkbox" id="warmup_skip" ${s.warmup_skip === '1' ? 'checked' : ''}> Passer la montée en charge (uniquement si ce compte envoie déjà ce volume régulièrement — risqué sinon)</label>` : ''}
    </div>` : ''}
    <div class="card">
      <h2>Serveur d'envoi (SMTP)</h2>
      <div class="field"><label>Fournisseur</label>
        <div class="row">${Object.keys(PRESETS).map((k) => `<button data-preset="${k}">${{ gmail: 'Gmail', outlook: 'Outlook / 365', ovh: 'OVH', ionos: 'IONOS', brevo: 'Brevo' }[k]}</button>`).join('')}</div>
        <div class="hint" id="preset-note">Choisissez un fournisseur pour pré-remplir, ou saisissez vos paramètres manuellement.</div></div>
      <div class="grid2">
        <div class="field"><label>Serveur SMTP</label><input type="text" id="smtp_host" value="${esc(s.smtp_host)}" placeholder="smtp.exemple.fr"></div>
        <div class="row" style="align-items:flex-start">
          <div class="field" style="flex:1"><label>Port</label><input type="number" id="smtp_port" value="${esc(s.smtp_port)}"></div>
          <div class="field" style="flex:2"><label>Sécurité</label><select id="smtp_secure"><option value="0" ${s.smtp_secure !== '1' ? 'selected' : ''}>STARTTLS (port 587)</option><option value="1" ${s.smtp_secure === '1' ? 'selected' : ''}>SSL/TLS (port 465)</option></select></div>
        </div>
        <div class="field"><label>Identifiant</label><input type="text" id="smtp_user" value="${esc(s.smtp_user)}" autocomplete="off"></div>
        <div class="field"><label>Mot de passe</label><input type="password" id="smtp_pass" value="${esc(s.smtp_pass)}" autocomplete="new-password"></div>
      </div>
      <h2 style="margin-top:8px">Expéditeur</h2>
      <div class="grid2">
        <div class="field"><label>Nom affiché</label><input type="text" id="from_name" value="${esc(s.from_name)}" placeholder="Jean Dupont — Ma Société"></div>
        <div class="field"><label>Adresse d'expédition</label><input type="email" id="from_email" value="${esc(s.from_email)}" placeholder="jean@masociete.fr"></div>
        <div class="field"><label>Adresse de réponse (optionnel)</label><input type="email" id="reply_to" value="${esc(s.reply_to)}"></div>
        <div class="field"><label>Limite globale d'envois par jour (0 = aucune)</label><input type="number" id="global_daily_limit" min="0" value="${esc(s.global_daily_limit)}">
          <div class="hint">Sécurité : toutes campagnes confondues, l'outil ne dépassera jamais ce nombre par jour.</div></div>
      </div>
      <h2 style="margin-top:8px">Lien de désinscription</h2>
      <div class="field"><label>Adresse publique de l'outil (optionnel)</label><input type="url" id="base_url" value="${esc(s.base_url)}" placeholder="https://mailing.masociete.fr">
        <div class="hint">Si l'outil est accessible depuis Internet, indiquez son adresse : un vrai lien « Se désinscrire » sera ajouté aux emails. Sinon, les emails proposent de répondre « STOP » et vous ajoutez l'adresse dans l'onglet Désinscrits.</div></div>
      <div class="row"><button class="primary" id="save">Enregistrer</button></div>
    </div>
    <div class="card">
      <h2>Tester la configuration</h2>
      <div class="row"><input type="email" id="test-to" placeholder="votre@email.fr" style="max-width:320px" value="${esc(localStorage.getItem('testTo') || s.from_email || '')}"><button id="test">Envoyer un email de test</button></div>
    </div>`;
  const ids = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'from_name', 'from_email', 'reply_to', 'global_daily_limit', 'base_url'];
  const read = () => {
    const out = Object.fromEntries(ids.map((i) => [i, $(`#${i}`).value]));
    if ($('#warmup_skip')) out.warmup_skip = $('#warmup_skip').checked ? '1' : '0';
    return out;
  };
  if ($('#unblock')) {
    $('#unblock').onclick = async () => {
      if (!confirm('Reprendre les envois avant la fin des 24 h augmente fortement le risque de suspension du compte. Continuer ?')) return;
      await api('/api/settings/unblock', { method: 'POST' }); viewSettings();
    };
  }
  if ($('#warmup_skip')) {
    $('#warmup_skip').onchange = (e) => {
      if (e.target.checked && !confirm('Sans montée en charge progressive, un compte qui ne prospecte pas déjà risque d\'être bloqué. Continuer ?')) e.target.checked = false;
    };
  }
  $$('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const p = PRESETS[b.dataset.preset];
      ['smtp_host', 'smtp_port', 'smtp_secure'].forEach((k) => { $(`#${k}`).value = p[k]; });
      $('#preset-note').textContent = p.note;
      if (!$('#smtp_user').value && $('#from_email').value) $('#smtp_user').value = $('#from_email').value;
    };
  });
  $('#smtp_secure').onchange = () => { $('#smtp_port').value = $('#smtp_secure').value === '1' ? '465' : '587'; };
  $('#save').onclick = async () => {
    try { await api('/api/settings', { method: 'PUT', body: read() }); toast('Paramètres enregistrés', 'success'); viewSettings(); } catch (e) { toast(e.message, 'error'); }
  };
  $('#test').onclick = async () => {
    const btn = $('#test'); btn.disabled = true; btn.textContent = 'Envoi…';
    try {
      await api('/api/settings', { method: 'PUT', body: read() });
      localStorage.setItem('testTo', $('#test-to').value);
      await api('/api/settings/test', { method: 'POST', body: { to: $('#test-to').value } });
      toast('Email de test envoyé ✅ Vérifiez votre boîte (et les spams).', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; btn.textContent = 'Envoyer un email de test'; }
  };
}

// ---------------------------------------------------------------------------
// Désinscrits
// ---------------------------------------------------------------------------
async function viewUnsubscribes() {
  app.innerHTML = `
    <div class="page-head"><h1>Désinscrits</h1></div>
    <div class="card">
      <p class="muted" style="margin-top:0">Ces adresses ne recevront plus aucun email, quelle que soit la campagne. Ajoutez ici les personnes qui ont répondu « STOP » ou demandé à ne plus être contactées.</p>
      <div class="field"><label>Ajouter des adresses (une par ligne, ou séparées par des virgules)</label><textarea id="emails" style="min-height:90px"></textarea></div>
      <button class="primary" id="add">Ajouter</button>
    </div>
    <div class="card"><div id="list"></div></div>`;
  const render = async () => {
    const list = await api('/api/unsubscribes');
    $('#list').innerHTML = list.length ? `<table><thead><tr><th>Email</th><th>Origine</th><th>Date</th><th></th></tr></thead><tbody>
      ${list.map((u) => `<tr><td>${esc(u.email)}</td><td class="muted">${esc(u.reason)}</td><td class="muted">${new Date(u.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td style="text-align:right"><button class="ghost danger" data-del="${esc(u.email)}">Retirer</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Aucune adresse désinscrite.</p>';
    $$('[data-del]').forEach((b) => { b.onclick = async () => { await api(`/api/unsubscribes/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); render(); }; });
  };
  $('#add').onclick = async () => {
    try {
      const r = await api('/api/unsubscribes', { method: 'POST', body: { emails: $('#emails').value } });
      toast(`${r.added} adresse(s) ajoutée(s)`, 'success'); $('#emails').value = ''; render();
    } catch (e) { toast(e.message, 'error'); }
  };
  render();
}
