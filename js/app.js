/* Génialogie : interface et synchronisation avec GitHub.
   Les données sont dans le fichier arbre.json d'un dépôt privé ; ce script parle directement à l'API de GitHub. */
(function () {
'use strict';

var Data = window.Data, GH = window.GH;
var CW = 184, CH = 68, HG = 28, VG = 72, ROW = CH + VG;
var POLL_MS = 60000, SAVE_DELAY = 800;

function $(s) { return document.querySelector(s); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function year(s) { var m = String(s || '').match(/\d{4}/); return m ? m[0] : ''; }
function cut(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/* ====================================================================
   Stockage local (sur cet appareil uniquement)
   ==================================================================== */
var KEY = 'genialogie.v1';
var S = { current: null, trees: [], user: '', theme: 'auto' };
function loadStore() {
  try {
    var o = JSON.parse(localStorage.getItem(KEY));
    if (o && Array.isArray(o.trees)) {
      S.trees = o.trees.filter(function (t) { return t && typeof t.repo === 'string' && typeof t.token === 'string'; });
      S.current = o.current; S.user = typeof o.user === 'string' ? o.user : '';
      S.theme = o.theme === 'light' || o.theme === 'dark' ? o.theme : 'auto';
    }
  } catch (e) { /* stockage indisponible : l'application fonctionne, sans mémoire */ }
}
function saveStore() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } }
function findTree(repo) {
  repo = String(repo).toLowerCase();
  for (var i = 0; i < S.trees.length; i++) if (S.trees[i].repo.toLowerCase() === repo) return S.trees[i];
  return null;
}
function viewKey(repo) { return 'genialogie.vue.' + repo.toLowerCase(); }
function userName() { return (S.user || '').trim() || 'Un membre'; }

/* ====================================================================
   Thème
   ==================================================================== */
function applyTheme() {
  var r = document.documentElement;
  if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
  $('#themeBtn').textContent = S.theme === 'auto' ? 'Thème : auto' : S.theme === 'light' ? 'Thème : clair' : 'Thème : sombre';
}
$('#themeBtn').onclick = function () {
  S.theme = S.theme === 'auto' ? 'light' : S.theme === 'light' ? 'dark' : 'auto';
  saveStore(); applyTheme();
};

/* ====================================================================
   Écrans
   ==================================================================== */
var SCREENS = ['welcome', 'join', 'create', 'app'];
function showScreen(name) {
  SCREENS.forEach(function (n) { $('#' + n).hidden = n !== name; });
  closeModal(); closeMenu();
  if (name === 'app') { needsFit = true; }
}
function setMsg(el, text, bad) { el.textContent = text || ''; el.classList.toggle('err', !!bad); }

function renderWelcome() {
  var box = $('#myTrees'), ul = $('#treeList');
  box.hidden = !S.trees.length;
  ul.innerHTML = S.trees.map(function (t, i) {
    return '<li><button type="button" class="btn" data-i="' + i + '">' + esc(t.nom || t.repo) + '</button></li>';
  }).join('');
  $('#backToApp').hidden = !sync;
}
function goWelcome() { renderWelcome(); showScreen('welcome'); }
$('#treeList').addEventListener('click', function (e) {
  var b = e.target.closest('[data-i]'); if (!b) return;
  openTree(S.trees[+b.getAttribute('data-i')].repo);
});
$('#backToApp').onclick = function () { showScreen('app'); };
$('#goJoin').onclick = function () { setMsg($('#joinMsg'), ''); $('#joinName').value = S.user; showScreen('join'); };
$('#goCreate').onclick = function () { setMsg($('#crMsg'), ''); $('#crName').value = S.user; updateCreate(); showScreen('create'); };
Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) { b.onclick = goWelcome; });

/* ====================================================================
   Rejoindre un arbre
   ==================================================================== */
function rememberUser(v) { v = (v || '').trim(); if (v && v !== S.user) { S.user = v; saveStore(); } }

function addOrUpdateTree(info, code, nom) {
  var t = findTree(info.full);
  if (!t) { t = { repo: info.full }; S.trees.push(t); }
  t.token = code.token; t.nom = nom || t.nom || code.nom || info.full;
  t.mode = info.canPush === false ? 'r' : code.mode; t.exp = info.exp || null;
  S.current = t.repo; saveStore();
  return t;
}
$('#joinGo').onclick = function () {
  var msg = $('#joinMsg'), btn = $('#joinGo'), code;
  try { code = GH.readCode($('#joinCode').value); } catch (e) { setMsg(msg, e.message, true); return; }
  rememberUser($('#joinName').value);
  btn.disabled = true; setMsg(msg, 'Connexion à GitHub…');
  GH.getRepo(code.token, code.repo).then(function (info) {
    return GH.getFile(code.token, info.full, GH.PATH).then(function (f) {
      if (!f) throw new Error('Le fichier arbre.json est introuvable dans ce dépôt : la personne qui a créé l\'arbre l\'a-t-elle terminé ?');
      var n; try { n = Data.normalize(JSON.parse(f.text)); } catch (e) { n = null; }
      if (!n) throw new Error('Le fichier arbre.json de ce dépôt n\'est pas un arbre Génialogie lisible.');
      addOrUpdateTree(info, code, n.nom);
      $('#joinCode').value = '';
      return openTree(info.full);
    });
  }).then(null, function (e) { setMsg(msg, e.message, true); })
    .then(function () { btn.disabled = false; });
};

/* ====================================================================
   Créer un arbre
   ==================================================================== */
var repoEdited = false;
function updateCreate() {
  var tree = $('#crTree').value.trim(), repo = GH.parseRepo($('#crRepoUrl').value);
  if (!repoEdited) $('#crRepoName').value = GH.slug(tree);
  var name = $('#crRepoName').value.trim() || GH.slug(tree);
  $('#crOpenRepo').href = GH.newRepoUrl(name, 'Arbre généalogique ' + (tree ? '« ' + tree + ' » ' : '') + '(Génialogie)');
  $('#crOpenToken').href = GH.tokenUrl(repo ? repo.owner : '', 'e', 'Génialogie' + (tree ? ' - ' + tree : ''));
  $('#st2').setAttribute('data-state', tree ? 'open' : 'wait');
  $('#st3').setAttribute('data-state', repo ? 'open' : 'wait');
}
$('#crTree').addEventListener('input', updateCreate);
$('#crRepoName').addEventListener('input', function () { repoEdited = true; updateCreate(); });
$('#crRepoUrl').addEventListener('input', updateCreate);

$('#crGo').onclick = function () {
  var msg = $('#crMsg'), btn = $('#crGo');
  var tree = $('#crTree').value.trim(), repo = GH.parseRepo($('#crRepoUrl').value), token = GH.cleanToken($('#crToken').value);
  if (!tree) { setMsg(msg, 'Donnez un nom à l\'arbre (étape 1).', true); return; }
  if (!repo) { setMsg(msg, 'Collez l\'adresse du dépôt créé (étape 2), par exemple https://github.com/vous/' + GH.slug(tree) + '.', true); return; }
  if (!token) { setMsg(msg, 'Le jeton est vide ou incomplet. Il commence par github_pat_.', true); return; }
  rememberUser($('#crName').value);
  btn.disabled = true; setMsg(msg, 'Vérification du dépôt…');
  var info;
  GH.getRepo(token, repo.full).then(function (i) {
    info = i;
    if (!info.isPrivate) throw new Error('Ce dépôt est public : tout le monde pourrait lire l\'arbre. Recréez-le en « Private ».');
    if (info.canPush === false) throw new Error('Ce jeton ne permet pas d\'écrire dans le dépôt : à l\'étape 2, choisissez « Read and write » pour Contents.');
    return GH.getFile(token, info.full, GH.PATH);
  }).then(function (f) {
    var nom = tree;
    if (f) {
      var n; try { n = Data.normalize(JSON.parse(f.text)); } catch (e) { n = null; }
      if (!n) throw new Error('Ce dépôt contient déjà un fichier arbre.json qui n\'est pas un arbre Génialogie. Utilisez un dépôt vide.');
      setMsg(msg, 'Un arbre existe déjà dans ce dépôt : ouverture.');
      return { nom: n.nom || tree, created: false };
    }
    setMsg(msg, 'Création de l\'arbre…');
    return GH.putFile(token, info.full, GH.PATH, Data.serialize({}, nom), null, 'Génialogie : création de l\'arbre « ' + nom + ' » (par ' + userName() + ')')
      .then(function () { return { nom: nom, created: true }; }, function (e) {
        if (e.status === 404 || e.status === 409 || e.status === 422)
          e.message += ' Si le dépôt est vide, recréez-le en cochant « Add a README file ».';
        throw e;
      });
  }).then(function (r) {
    addOrUpdateTree(info, { token: token, mode: 'e', nom: r.nom }, r.nom);
    $('#crToken').value = ''; $('#crTree').value = ''; $('#crRepoUrl').value = ''; repoEdited = false;
    return openTree(info.full).then(function () { openShare(true); });
  }).then(null, function (e) { setMsg(msg, e.message, true); })
    .then(function () { btn.disabled = false; });
};

/* ====================================================================
   Données de l'arbre ouvert
   ==================================================================== */
var db = {};                            // personnes : id → fiche
var vw = { focus: null, anc: 3, desc: 2 };  // vue (propre à chaque appareil)
var sync = null;                        // état de la synchronisation de l'arbre ouvert

function P(id) { return db[id]; }
function RO() { return !sync || sync.readonly || sync.locked; }
function ids() { return Object.keys(db); }
function fullName(p) { return [p.prenom, p.nom].filter(Boolean).join(' ') || 'Sans nom'; }
function byBirth(a, b) { var x = +year(a.naissance.date) || 9999, y = +year(b.naissance.date) || 9999; return x - y; }
function byName(a, b) { return (a.nom + ' ' + a.prenom).localeCompare(b.nom + ' ' + b.prenom, 'fr'); }
function childrenOf(id) { return ids().map(P).filter(function (c) { return c.parents.indexOf(id) > -1; }).sort(byBirth); }
function life(p) { var b = year(p.naissance.date), d = year(p.deces.date); return (b || d) ? ((b || '?') + ' – ' + d) : ''; }
function isAncOrSelf(x, a, seen) {
  seen = seen || {};
  if (x === a) return true;
  if (seen[x] || !P(x)) return false; seen[x] = 1;
  return P(x).parents.some(function (q) { return isAncOrSelf(q, a, seen); });
}
function label(id) { return P(id) ? fullName(P(id)) : id; }

function persistView() { if (sync) try { localStorage.setItem(viewKey(sync.entry.repo), JSON.stringify(vw)); } catch (e) { } }
function loadView(repo) {
  var v = null;
  try { v = JSON.parse(localStorage.getItem(viewKey(repo))); } catch (e) { }
  vw = { focus: v && typeof v.focus === 'string' ? v.focus : null, anc: clamp(+(v && v.anc) || 3, 1, 4), desc: clamp(+(v && v.desc) || 2, 1, 3) };
  fixFocus();
  $('#anc').value = vw.anc; $('#desc').value = vw.desc;
}
function fixFocus() {
  if (vw.focus && P(vw.focus)) return;
  var l = ids().map(P).sort(byName);
  vw.focus = l.length ? l[0].id : null;
}

/* ====================================================================
   Ouverture d'un arbre
   ==================================================================== */
function openTree(repo) {
  var entry = findTree(repo);
  if (!entry) return Promise.resolve();
  if (sync) { flushNow(); clearTimeout(sync.timer); }
  S.current = entry.repo; saveStore();
  var ctx = { entry: entry, readonly: entry.mode === 'r', locked: false, sha: null, base: {}, nom: entry.nom || '', busy: false, again: false, timer: 0, authFail: false, exp: entry.exp || null };
  sync = ctx; db = {}; vw = { focus: null, anc: 3, desc: 2 };
  clearBanner(); setStatus('Chargement…');
  $('#roBadge').hidden = true; document.body.removeAttribute('data-readonly');
  $('#treeName').textContent = entry.nom || entry.repo;
  $('#repoLink').href = 'https://github.com/' + entry.repo; $('#repoLink').textContent = entry.repo;
  setSheet(false); setView('tree');
  showScreen('app'); renderAll();
  return GH.getFile(entry.token, entry.repo, GH.PATH).then(function (f) {
    if (sync !== ctx) return;
    noteExpiry(ctx, f && f.exp);
    var n = null;
    if (f) { try { n = Data.normalize(JSON.parse(f.text)); } catch (e) { n = null; } }
    if (!f || !n) {
      ctx.locked = true;
      showBanner(f ? 'Le fichier arbre.json de ce dépôt est illisible : Génialogie n\'y écrira rien pour ne rien écraser.' : 'Le fichier arbre.json est introuvable dans ce dépôt.');
      setStatus('Arbre non chargé', true);
    } else {
      ctx.sha = f.sha; ctx.base = n.people; db = Data.clone(n.people);
      if (n.nom) setTreeName(n.nom);
      setStatus('À jour');
    }
    loadView(entry.repo); applyRO(); renderAll(); fit(false);
  }, function (e) {
    if (sync !== ctx) return;
    ctx.locked = true; applyRO(); renderAll();
    onError(e, ctx, 'Arbre non chargé');
  });
}
function setTreeName(nom) {
  if (!sync) return;
  sync.nom = nom; sync.entry.nom = nom; saveStore(); $('#treeName').textContent = nom;
}
function applyRO() {
  var ro = RO();
  document.body.toggleAttribute('data-readonly', ro);
  $('#roBadge').hidden = !(sync && sync.readonly);
  $('#shareBtn').hidden = !sync;
}

/* ====================================================================
   Bandeau, état
   ==================================================================== */
var bannerAct = null;
function setStatus(t, bad) { var s = $('#status'); s.textContent = t; s.style.color = bad ? 'var(--danger-ink)' : ''; }
function showBanner(text, actLabel, actFn) {
  $('#bannerText').textContent = text;
  var b = $('#bannerAct'); b.hidden = !actLabel; b.textContent = actLabel || ''; bannerAct = actFn || null;
  $('#banner').hidden = false;
}
function clearBanner() { $('#banner').hidden = true; bannerAct = null; }
$('#bannerX').onclick = clearBanner;
$('#bannerAct').onclick = function () { if (bannerAct) bannerAct(); };

function noteExpiry(ctx, exp) {
  if (!exp || ctx !== sync) return;
  ctx.exp = exp; ctx.entry.exp = exp; saveStore();
  var d = GH.expiryDays(exp);
  if (d !== null && d < 21 && $('#banner').hidden)
    showBanner(d < 0 ? 'Le jeton a expiré.' : 'Le jeton d\'accès expire dans ' + d + ' jour' + (d > 1 ? 's' : '') + '. Pensez à en créer un nouveau.', 'Changer le jeton', function () { openShare(false); });
}
function onError(e, ctx, prefix) {
  if (ctx !== sync) return;
  if (e.status === 401) {
    ctx.authFail = true;
    showBanner(e.message + ' Il faut en créer un nouveau.', 'Changer le jeton', function () { openShare(false); });
    setStatus('Jeton refusé', true);
  } else if (e.status === 403 && !/Limite/.test(e.message) && !ctx.readonly && ctx.writing) {
    ctx.readonly = true; applyRO(); renderAll();
    showBanner('Ce jeton n\'a pas le droit d\'écrire : l\'arbre est passé en lecture seule. Vos dernières modifications n\'ont pas été enregistrées.');
    setStatus('Lecture seule', true);
  } else if (e.status === 0) {
    setStatus('Hors connexion : nouvel essai bientôt', true);
    if (!ctx.readonly && !ctx.timer) ctx.timer = setTimeout(flush, 10000);
  } else {
    setStatus((prefix ? prefix + ' : ' : '') + e.message, true);
  }
}

/* ====================================================================
   Synchronisation
   ==================================================================== */
function describe(ops) {
  var parts = [];
  ops.add.slice(0, 2).forEach(function (p) { parts.push('ajout de ' + fullName(p)); });
  ops.set.slice(0, 2).forEach(function (s) { parts.push('modification de ' + label(s.id)); });
  if (ops.del.length) parts.push(ops.del.length + ' suppression' + (ops.del.length > 1 ? 's' : ''));
  var n = Data.count(ops), shown = Math.min(ops.add.length, 2) + Math.min(ops.set.length, 2) + (ops.del.length ? 1 : 0);
  if (!parts.length) parts.push('liens de parenté');
  else if (n > shown + 1 || ops.parents_add.length + ops.parents_del.length + ops.unions_add.length + ops.unions_del.length) parts.push('etc.');
  return parts.join(', ');
}
function save() {
  persistView();
  if (RO()) return;
  setStatus('Modifications en attente…');
  clearTimeout(sync.timer); sync.timer = setTimeout(flush, SAVE_DELAY);
}
function flushNow() { if (sync && sync.timer) flush(); }
function dirty() { return !!sync && !sync.locked && !sync.readonly && !Data.isEmpty(Data.diff(sync.base, db)); }

function flush() {
  var ctx = sync;
  if (!ctx) return;
  clearTimeout(ctx.timer); ctx.timer = 0;
  if (ctx.locked || ctx.readonly || ctx.authFail) return;
  if (ctx.busy) { ctx.again = true; return; }
  if (Data.isEmpty(Data.diff(ctx.base, db))) { setStatus('Enregistré'); return; }
  ctx.busy = true; ctx.writing = true; setStatus('Enregistrement…');
  attempt(ctx, 0).then(null, function (e) { onError(e, ctx); })
    .then(function () {
      ctx.busy = false; ctx.writing = false;
      if (ctx.again) { ctx.again = false; if (ctx === sync) flush(); }
    });
}
/* envoie l'état local ; en cas de conflit, relit le dépôt, rejoue mes changements dessus, et recommence */
function attempt(ctx, n) {
  if (ctx !== sync) return Promise.resolve();
  var ops = Data.diff(ctx.base, db);
  if (Data.isEmpty(ops)) { setStatus('Enregistré'); return Promise.resolve(); }
  var sent = Data.clone(db);
  var msg = 'Génialogie : ' + describe(ops) + ' (par ' + userName() + ')';
  return GH.putFile(ctx.entry.token, ctx.entry.repo, GH.PATH, Data.serialize(sent, ctx.nom), ctx.sha, msg).then(function (r) {
    if (ctx !== sync) return;
    ctx.sha = r.sha; ctx.base = sent; noteExpiry(ctx, r.exp);
    setStatus(Data.isEmpty(Data.diff(ctx.base, db)) ? 'Enregistré' : 'Modifications en attente…');
    if (!Data.isEmpty(Data.diff(ctx.base, db))) { ctx.again = true; }
  }, function (e) {
    if (!e.conflict || n >= 4) { if (e.conflict) e.message = 'Trop de modifications simultanées : réessayez dans un instant.'; throw e; }
    return GH.getFile(ctx.entry.token, ctx.entry.repo, GH.PATH).then(function (f) {
      if (ctx !== sync) return;
      var rn = null;
      if (f) { try { rn = Data.normalize(JSON.parse(f.text)); } catch (x) { rn = null; } }
      if (!rn) { ctx.locked = true; applyRO(); showBanner('Le fichier arbre.json est devenu illisible : plus rien n\'est écrit.'); throw new Error('arbre.json illisible'); }
      var mine = Data.diff(ctx.base, db);
      var res = Data.applyOps(rn.people, mine, function (id) { return P(id) ? fullName(P(id)) : (ctx.base[id] ? fullName(ctx.base[id]) : id); });
      ctx.sha = f.sha; ctx.base = rn.people;
      if (rn.nom && rn.nom !== ctx.nom) setTreeName(rn.nom);
      adopt(res.people);
      if (res.notes.length) showBanner('Fusion avec les modifications d\'un autre membre. ' + res.notes.join(' '));
      return attempt(ctx, n + 1);
    });
  });
}
/* remplace la base locale par une version fusionnée, sans perturber la saisie en cours */
function adopt(people) {
  var f = vw.focus && P(vw.focus) ? JSON.stringify(P(vw.focus)) : null;
  db = people; fixFocus();
  var after = vw.focus && P(vw.focus) ? JSON.stringify(P(vw.focus)) : null;
  var typing = document.activeElement && $('#sheetBody').contains(document.activeElement);
  renderRegistry(); renderTree();
  if (!(typing && f === after)) renderSheet();
}

/* relecture du dépôt (bouton, minuterie, retour sur l'onglet) */
function refresh(manual) {
  var ctx = sync;
  if (!ctx || ctx.locked || ctx.authFail) { if (manual && ctx && ctx.locked) openTree(ctx.entry.repo); return Promise.resolve(); }
  if (ctx.busy) return Promise.resolve();
  if (dirty() || ctx.timer) { if (manual) { flush(); } return Promise.resolve(); }
  if (manual) setStatus('Actualisation…');
  return GH.getFile(ctx.entry.token, ctx.entry.repo, GH.PATH).then(function (f) {
    if (ctx !== sync || ctx.busy || dirty() || ctx.timer) return;
    noteExpiry(ctx, f && f.exp);
    if (!f) { setStatus('arbre.json introuvable', true); return; }
    if (f.sha === ctx.sha) { setStatus('À jour'); return; }
    var n; try { n = Data.normalize(JSON.parse(f.text)); } catch (x) { n = null; }
    if (!n) { setStatus('arbre.json illisible : modifications distantes ignorées', true); return; }
    ctx.sha = f.sha; ctx.base = n.people;
    if (n.nom && n.nom !== ctx.nom) setTreeName(n.nom);
    adopt(Data.clone(n.people));
    setStatus('À jour (modifications reçues)');
  }, function (e) { if (manual || e.status !== 0) onError(e, ctx); });
}
$('#refreshBtn').onclick = function () { refresh(true); };
setInterval(function () { if (document.visibilityState === 'visible' && sync) refresh(false); }, POLL_MS);
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') flushNow(); else if (sync) refresh(false);
});
window.addEventListener('pagehide', flushNow);
window.addEventListener('beforeunload', function (e) {
  if (sync && (sync.timer || sync.busy || dirty())) { e.preventDefault(); e.returnValue = ''; }
});

/* ====================================================================
   Parenté
   ==================================================================== */
function uniq(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }
function emptyEv(e) { return !(e.date || e.lieu); }
function syncMarriage(a, b) {
  if (emptyEv(a.mariage) && !emptyEv(b.mariage)) a.mariage = { date: b.mariage.date, lieu: b.mariage.lieu };
  else if (emptyEv(b.mariage) && !emptyEv(a.mariage)) b.mariage = { date: a.mariage.date, lieu: a.mariage.lieu };
}
function link(kind, pid, oid) {
  var p = P(pid), o = P(oid);
  if (!o || pid === oid) return 'Choisissez une autre personne.';
  if (kind === 'conjoints') {
    uniq(p.conjoints, oid); uniq(o.conjoints, pid); p.conjoints.sort(); o.conjoints.sort(); syncMarriage(p, o);
  } else if (kind === 'parents') {
    if (p.parents.length >= 2) return 'Cette personne a déjà deux parents.';
    if (isAncOrSelf(oid, pid)) return 'Cette personne descend de la fiche en cours.';
    uniq(p.parents, oid);
  } else {
    if (o.parents.length >= 2) return fullName(o) + ' a déjà deux parents.';
    if (isAncOrSelf(pid, oid)) return 'Cette personne est un ancêtre de la fiche en cours.';
    uniq(o.parents, pid);
  }
  return '';
}
function unlink(kind, pid, oid) {
  var p = P(pid), o = P(oid);
  if (kind === 'conjoints') {
    p.conjoints = p.conjoints.filter(function (i) { return i !== oid; });
    if (o) o.conjoints = o.conjoints.filter(function (i) { return i !== pid; });
  } else if (kind === 'parents') {
    p.parents = p.parents.filter(function (i) { return i !== oid; });
  } else if (o) {
    o.parents = o.parents.filter(function (i) { return i !== pid; });
  }
}

/* ====================================================================
   Mise en page de l'arbre
   ==================================================================== */
function ancDepth(id, lim, seen) {
  seen = seen || {};
  if (lim <= 0 || seen[id]) return 0;
  var s = Object.assign({}, seen); s[id] = 1;
  var ps = P(id).parents.filter(P);
  if (!ps.length) return 0;
  return 1 + Math.max.apply(null, ps.map(function (q) { return ancDepth(q, lim - 1, s); }));
}
function descTree(id, L, seen) {
  var p = P(id), sp = p.conjoints.filter(P);
  var kids = L < vw.desc ? childrenOf(id).filter(function (c) { return !seen[c.id]; }) : [];
  kids.forEach(function (c) { seen[c.id] = 1; });
  var n = { id: id, sp: sp, kids: kids.map(function (c) { return descTree(c.id, L + 1, seen); }) };
  n.unitW = (1 + sp.length) * CW + sp.length * HG;
  n.kw = n.kids.reduce(function (a, k) { return a + k.w; }, 0) + Math.max(0, n.kids.length - 1) * HG;
  n.w = Math.max(n.unitW, n.kw);
  return n;
}
function layout(fid) {
  var nodes = [], links = [];
  var D = ancDepth(fid, vw.anc);
  var W = (CW + HG) * Math.pow(2, D);
  var seen = {}; seen[fid] = 1; P(fid).conjoints.forEach(function (s) { seen[s] = 1; });
  var root = descTree(fid, 0, seen);
  function placeDesc(n, cx, L) {
    var y = L * ROW, ul = cx - n.unitW / 2;
    var pn = { id: n.id, x: ul + CW / 2, y: y, kind: L ? 'desc' : 'focus' };
    nodes.push(pn);
    n.sp.forEach(function (s, i) {
      var sx = ul + (i + 1) * (CW + HG) + CW / 2;
      nodes.push({ id: s, x: sx, y: y, kind: 'spouse' });
      links.push({ t: 'couple', x1: sx - CW - HG + CW / 2, x2: sx - CW / 2, y: y + CH / 2 });
    });
    var start = cx - n.kw / 2, ks = [];
    n.kids.forEach(function (k) { ks.push(placeDesc(k, start + k.w / 2, L + 1)); start += k.w + HG; });
    if (ks.length) links.push({ t: 'desc', x: cx, y: n.sp.length === 1 ? y + CH / 2 : y + CH, my: y + CH + VG / 2, ks: ks });
    return pn;
  }
  var fnode = placeDesc(root, -CW / 2 + root.unitW / 2, 0);
  function up(cn, id, L, s, path) {
    if (L >= vw.anc) return;
    var ps = P(id).parents.filter(function (q) { return P(q) && !path[q]; }), pn = [];
    ps.forEach(function (q, i) {
      var sl = 2 * s + i, lv = L + 1;
      var n = { id: q, x: (sl + .5) * W / Math.pow(2, lv) - W / 2, y: -lv * ROW, kind: 'anc' };
      nodes.push(n); pn.push(n);
      var np = Object.assign({}, path); np[q] = 1;
      up(n, q, lv, sl, np);
    });
    if (pn.length) links.push({ t: 'anc', c: cn, ps: pn });
  }
  var path = {}; path[fid] = 1;
  up(fnode, fid, 0, 0, path);
  return { nodes: nodes, links: links };
}

/* ====================================================================
   Rendu de l'arbre
   ==================================================================== */
var nodes = [];
function evLine(sym, e) { return (e.date || e.lieu) ? sym + ' ' + [e.date, e.lieu].filter(Boolean).join(', ') : ''; }
function cardSvg(n) {
  var p = P(n.id), nm = fullName(p), by = year(p.naissance.date), dy = year(p.deces.date);
  var dates = [by && ('* ' + by), dy && ('† ' + dy)].filter(Boolean).join('   ') || '—';
  var tip = [nm, p.profession, evLine('*', p.naissance), evLine('⚭', p.mariage), evLine('†', p.deces)].filter(Boolean).join('\n');
  return '<g class="card ' + n.kind + '" data-id="' + esc(n.id) + '" tabindex="0" role="button" aria-label="' + esc(nm + ', ' + (life(p) || 'dates inconnues')) + '" transform="translate(' + (n.x - CW / 2) + ' ' + n.y + ')">'
    + '<title>' + esc(tip) + '</title>'
    + '<rect width="' + CW + '" height="' + CH + '" rx="7"/>'
    + '<text class="nm" x="12" y="24">' + esc(cut(nm, 22)) + '</text>'
    + '<text class="dt" x="12" y="42">' + esc(dates) + '</text>'
    + '<text class="jb" x="12" y="58">' + esc(cut(p.profession || '', 30)) + '</text></g>';
}
function renderTree() {
  var gl = $('#links'), gc = $('#cards');
  if (!vw.focus || !P(vw.focus)) {
    gl.innerHTML = ''; gc.innerHTML = ''; nodes = [];
    $('#emptyText').textContent = RO() ? 'L\'arbre est vide pour le moment.' : 'L\'arbre est vide.';
    $('#empty').hidden = !sync || sync.locked ? true : false;
    return;
  }
  $('#empty').hidden = true;
  var lay = layout(vw.focus); nodes = lay.nodes;
  var d = '', dc = '';
  lay.links.forEach(function (l) {
    if (l.t === 'anc') {
      var my = l.c.y - VG / 2; d += 'M' + l.c.x + ' ' + l.c.y + 'V' + my;
      l.ps.forEach(function (p) { d += 'M' + l.c.x + ' ' + my + 'H' + p.x + 'V' + (p.y + CH); });
    } else if (l.t === 'desc') {
      d += 'M' + l.x + ' ' + l.y + 'V' + l.my;
      l.ks.forEach(function (k) { d += 'M' + l.x + ' ' + l.my + 'H' + k.x + 'V' + k.y; });
    } else { dc += 'M' + l.x1 + ' ' + l.y + 'H' + l.x2; }
  });
  gl.innerHTML = '<path class="tl" d="' + d + '"/><path class="cl" d="' + dc + '"/>';
  gc.innerHTML = nodes.map(cardSvg).join('');
}

/* ====================================================================
   Zoom, déplacement, recentrage
   ==================================================================== */
var stage = $('#stage'), svg = $('#svg'), vp = $('#vp');
var view = { x: 0, y: 0, k: 1 }, raf = 0, needsFit = false;
var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function apply() { vp.setAttribute('transform', 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')'); }
function goTo(t, animate) {
  cancelAnimationFrame(raf);
  if (!animate || reduce) { view = { x: t.x, y: t.y, k: t.k }; apply(); return; }
  var s = { x: view.x, y: view.y, k: view.k }, t0 = performance.now(), dur = 280;
  (function step(now) {
    var u = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - u, 3);
    view = { x: s.x + (t.x - s.x) * e, y: s.y + (t.y - s.y) * e, k: s.k + (t.k - s.k) * e }; apply();
    if (u < 1) raf = requestAnimationFrame(step);
  })(t0);
}
function usableW() {
  var W = stage.clientWidth, sh = $('#sheet');
  if (sheetOpen && !narrow() && sh) W = Math.max(160, W - sh.offsetWidth - 20);
  return W;
}
function fit(animate) {
  if (!nodes.length) return;
  var W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) { needsFit = true; return; }
  var a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  nodes.forEach(function (n) { a = Math.min(a, n.x - CW / 2); c = Math.max(c, n.x + CW / 2); b = Math.min(b, n.y); d = Math.max(d, n.y + CH); });
  W = usableW();
  var padX = 40, top = 64, padB = 44;
  var k = clamp(Math.min((W - 2 * padX) / (c - a), (H - top - padB) / (d - b)), .15, 1.3);
  var off = top + ((H - top - padB) - k * (d - b)) / 2;
  goTo({ k: k, x: W / 2 - k * (a + c) / 2, y: off - k * b }, animate);
}
function centerOnFocus(animate) {
  var W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) { needsFit = true; return; }
  goTo({ k: view.k, x: usableW() / 2, y: H / 2 - view.k * CH / 2 }, animate);
}
function zoomAt(px, py, f) {
  cancelAnimationFrame(raf);
  var k = clamp(view.k * f, .15, 2.5), r = k / view.k;
  view = { x: px - (px - view.x) * r, y: py - (py - view.y) * r, k: k }; apply();
}
svg.addEventListener('wheel', function (e) {
  e.preventDefault();
  var r = svg.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
var ptrs = new Map(), moved = 0, downId = null, lastDist = 0;
function dist() { var v = Array.from(ptrs.values()); return Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y) || 1; }
svg.addEventListener('pointerdown', function (e) {
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  cancelAnimationFrame(raf);
  if (ptrs.size === 1) { moved = 0; var c = e.target.closest && e.target.closest('.card'); downId = c ? c.getAttribute('data-id') : null; }
  else { downId = null; lastDist = dist(); }
  try { svg.setPointerCapture(e.pointerId); } catch (x) { }
});
svg.addEventListener('pointermove', function (e) {
  var p = ptrs.get(e.pointerId); if (!p) return;
  var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  if (ptrs.size === 1) { if (moved > 5) { view.x += dx; view.y += dy; apply(); } }
  else if (ptrs.size === 2) {
    var v = Array.from(ptrs.values()), r = svg.getBoundingClientRect(), d = dist();
    zoomAt((v[0].x + v[1].x) / 2 - r.left, (v[0].y + v[1].y) / 2 - r.top, d / lastDist); lastDist = d;
  }
});
var lastTap = null;
function tapCard(id) {
  var now = Date.now();
  if (lastTap && lastTap.id === id && now - lastTap.t < 300) {
    clearTimeout(lastTap.timer); lastTap = null;
    setFocus(id, true);
    return;
  }
  var el = document.querySelector('.card[data-id="' + id + '"]');
  if (el) el.classList.add('pending');
  var tap = { id: id, t: now };
  tap.timer = setTimeout(function () { if (lastTap === tap) lastTap = null; setFocus(id); }, 300);
  lastTap = tap;
}
function endPtr(e) {
  var wasOne = ptrs.size === 1;
  ptrs.delete(e.pointerId);
  if (wasOne && e.type === 'pointerup' && moved <= 5 && downId) { var id = downId; downId = null; tapCard(id); }
  if (!ptrs.size) downId = null;
}
svg.addEventListener('pointerup', endPtr);
svg.addEventListener('pointercancel', endPtr);
$('#cards').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var c = e.target.closest && e.target.closest('.card');
  if (c) { e.preventDefault(); var cid = c.getAttribute('data-id'); setFocus(cid, e.key === 'Enter' && cid === vw.focus); }
});
$('#zin').onclick = function () { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25); };
$('#zout').onclick = function () { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.25); };
$('#ctr').onclick = function () { centerOnFocus(true); };
$('#fit').onclick = function () { fit(true); };
var lastW = 0, lastH = 0;
if (window.ResizeObserver) {
  new ResizeObserver(function () {
    var W = stage.clientWidth, H = stage.clientHeight;
    if (needsFit && W > 0) { needsFit = false; fit(false); }
    else if (lastW > 0 && W > 0) { view.x += (W - lastW) / 2; view.y += (H - lastH) / 2; apply(); }
    if (W > 0) { lastW = W; lastH = H; }
  }).observe(stage);
}

/* ====================================================================
   Registre
   ==================================================================== */
function renderRegistry() {
  var q = $('#q').value.trim().toLowerCase();
  var all = ids().map(P).sort(byName);
  $('#count').textContent = all.length + ' personne' + (all.length > 1 ? 's' : '');
  var list = q ? all.filter(function (p) {
    return [p.prenom, p.nom, p.profession, p.naissance.lieu, p.mariage.lieu, p.deces.lieu].join(' ').toLowerCase().indexOf(q) > -1;
  }) : all;
  $('#list').innerHTML = list.map(function (p) {
    return '<li><button type="button" class="row' + (p.id === vw.focus ? ' on' : '') + '" data-id="' + esc(p.id) + '">'
      + '<span class="rn">' + esc(p.nom || '—') + ' <span>' + esc(p.prenom) + '</span></span>'
      + '<span class="rd">' + esc(life(p) || 'dates inconnues') + '</span></button></li>';
  }).join('') || '<li class="none">' + (all.length ? 'Aucun résultat.' : 'Aucune personne.') + '</li>';
}
$('#q').addEventListener('input', renderRegistry);
$('#list').addEventListener('click', function (e) {
  var b = e.target.closest('[data-id]'); if (!b) return;
  setFocus(b.getAttribute('data-id'));
  if (narrow()) setView('tree');
});
$('#list').addEventListener('dblclick', function (e) {
  var b = e.target.closest('[data-id]'); if (!b) return;
  setFocus(b.getAttribute('data-id'), true);
});

/* ====================================================================
   Fiche
   ==================================================================== */
function fld(k, lab, v, cls, ph) {
  return '<label>' + lab + '<input id="f-' + k.replace('.', '-') + '" data-k="' + k + '" value="' + esc(v) + '"'
    + (cls ? ' class="' + cls + '"' : '') + (ph ? ' placeholder="' + ph + '"' : '') + '></label>';
}
function evSet(sym, title, k, e) {
  return '<fieldset><legend>' + sym + ' ' + title + '</legend><div class="row2">'
    + fld(k + '.date', 'Date', e.date, 'mono', 'JJ/MM/AAAA ou année')
    + fld(k + '.lieu', 'Lieu', e.lieu, '', 'Ville') + '</div></fieldset>';
}
function linkSet(kind, title, p) {
  var list = kind === 'enfants' ? childrenOf(p.id).map(function (c) { return c.id; }) : p[kind];
  var chips = list.map(function (id) {
    return '<span class="chip"><button type="button" class="go" data-go="' + esc(id) + '">' + esc(fullName(P(id))) + '</button>'
      + '<button type="button" class="x" data-unlink="' + kind + ':' + esc(id) + '" aria-label="Retirer le lien">×</button></span>';
  }).join('');
  var opts = ids().map(P).filter(function (o) { return o.id !== p.id && list.indexOf(o.id) < 0; }).sort(byName)
    .map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(fullName(o) + (life(o) ? ' (' + life(o) + ')' : '')) + '</option>'; }).join('');
  return '<fieldset><legend>' + title + '</legend>'
    + (chips ? '<div class="chips">' + chips + '</div>' : '<p class="none-text">Aucun lien enregistré.</p>')
    + '<div class="adder"><select id="sel-' + kind + '" data-sel="' + kind + '" aria-label="Lier une personne existante"><option value="">Lier une personne existante…</option>' + opts + '</select></div>'
    + '<div class="adder"><input id="new-' + kind + '" placeholder="Prénom Nom (nouvelle personne)" aria-label="Nouvelle personne"><button type="button" class="btn" data-create="' + kind + '">Créer</button></div>'
    + '<p class="hint" id="hint-' + kind + '" role="status"></p></fieldset>';
}
function renderSheet() {
  var body = $('#sheetBody');
  if (!vw.focus || !P(vw.focus)) { body.innerHTML = '<p class="none-text">Aucune fiche.' + (RO() ? '' : ' Ajoutez une personne depuis le registre.') + '</p>'; return; }
  var p = P(vw.focus);
  body.innerHTML = '<form id="f" autocomplete="off" onsubmit="return false"' + (RO() ? ' class="ro"' : '') + '>'
    + '<div class="row2">' + fld('prenom', 'Prénom', p.prenom) + fld('nom', 'Nom', p.nom) + '</div>'
    + fld('profession', 'Profession', p.profession)
    + evSet('*', 'Naissance', 'naissance', p.naissance)
    + evSet('⚭', 'Mariage', 'mariage', p.mariage)
    + evSet('†', 'Décès', 'deces', p.deces)
    + linkSet('conjoints', 'Époux / épouse', p)
    + linkSet('parents', 'Parents', p)
    + linkSet('enfants', 'Enfants', p)
    + '<button type="button" id="del" class="btn danger">Supprimer cette personne</button></form>';
  if (RO()) {
    Array.prototype.forEach.call(body.querySelectorAll('input'), function (i) { i.readOnly = true; });
    Array.prototype.forEach.call(body.querySelectorAll('select'), function (i) { i.disabled = true; });
  }
}
function hint(kind, msg) { var h = $('#hint-' + kind); if (h) h.textContent = msg; }
function setPath(p, k, v) { var s = k.split('.'); if (s[1]) p[s[0]][s[1]] = v; else p[s[0]] = v; }
function commit(rebuildSheet) {
  save(); renderRegistry(); renderTree();
  if (rebuildSheet) renderSheet();
}
var sheet = $('#sheetBody');
sheet.addEventListener('input', function (e) {
  var k = e.target.getAttribute('data-k'); if (!k || !vw.focus || RO()) return;
  var p = P(vw.focus); setPath(p, k, e.target.value.slice(0, 200));
  if (k.indexOf('mariage') === 0) p.conjoints.forEach(function (s) { if (P(s)) P(s).mariage = { date: p.mariage.date, lieu: p.mariage.lieu }; });
  commit(false);
});
sheet.addEventListener('change', function (e) {
  var kind = e.target.getAttribute('data-sel'); if (!kind || !e.target.value || RO()) return;
  var msg = link(kind, vw.focus, e.target.value);
  if (msg) { hint(kind, msg); e.target.value = ''; return; }
  commit(true);
});
function createAndLink(kind) {
  if (RO()) return;
  var inp = $('#new-' + kind), t = inp.value.trim();
  if (!t) { hint(kind, 'Saisissez un prénom et un nom.'); return; }
  var parts = t.split(/\s+/), nom = parts.length > 1 ? parts.pop() : '', id = Data.uid(db), n = Data.blank(id);
  n.prenom = parts.join(' ').slice(0, 200); n.nom = nom.slice(0, 200); db[id] = n;
  var msg = link(kind, vw.focus, id);
  if (msg) { delete db[id]; hint(kind, msg); return; }
  commit(true);
}
sheet.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.id && e.target.id.indexOf('new-') === 0) { e.preventDefault(); createAndLink(e.target.id.slice(4)); }
});
function arm(btn, lab, fn) {
  if (btn.getAttribute('data-armed')) { clearTimeout(+btn.getAttribute('data-armed')); btn.removeAttribute('data-armed'); btn.classList.remove('armed'); fn(); return; }
  var orig = btn.textContent; btn.textContent = lab; btn.classList.add('armed');
  btn.setAttribute('data-armed', setTimeout(function () {
    btn.removeAttribute('data-armed'); btn.classList.remove('armed'); btn.textContent = orig;
  }, 4000));
}
sheet.addEventListener('click', function (e) {
  var t = e.target;
  var go = t.closest('[data-go]'); if (go) { setFocus(go.getAttribute('data-go')); return; }
  if (RO()) return;
  var un = t.closest('[data-unlink]');
  if (un) { var s = un.getAttribute('data-unlink').split(':'); unlink(s[0], vw.focus, s[1]); commit(true); return; }
  var cr = t.closest('[data-create]'); if (cr) { createAndLink(cr.getAttribute('data-create')); return; }
  var del = t.closest('#del');
  if (del) arm(del, 'Confirmer la suppression', deletePerson);
});
function deletePerson() {
  var id = vw.focus, p = P(id); if (!p || RO()) return;
  var next = p.conjoints[0] || p.parents[0] || (childrenOf(id)[0] || {}).id;
  ids().forEach(function (i) {
    var o = db[i];
    o.conjoints = o.conjoints.filter(function (x) { return x !== id; });
    o.parents = o.parents.filter(function (x) { return x !== id; });
  });
  delete db[id];
  if (!next || !P(next)) next = ids()[0] || null;
  vw.focus = next; save(); renderAll();
  if (next) centerOnFocus(true);
}

/* ====================================================================
   Navigation
   ==================================================================== */
function narrow() { return window.matchMedia('(max-width: 960px)').matches; }
function setView(v) {
  $('#app').setAttribute('data-view', v);
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
  if (v === 'tree') needsFit = true;
}
Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
  b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
});
var cols = { list: true };
try { var c0 = JSON.parse(localStorage.getItem('genialogie.colonnes')); if (c0) cols.list = c0.list !== false; } catch (e) { }
function applyCols() {
  $('#app').toggleAttribute('data-hide-list', !cols.list);
  $('#tgList').setAttribute('aria-pressed', String(cols.list));
  try { localStorage.setItem('genialogie.colonnes', JSON.stringify(cols)); } catch (e) { }
}
$('#tgList').onclick = function () { cols.list = !cols.list; applyCols(); };
applyCols();

var sheetOpen = false;
function setSheet(open) {
  sheetOpen = open;
  $('#app').toggleAttribute('data-sheet', open);
  $('#tgSheet').setAttribute('aria-pressed', String(open));
}
function openSheet() { if (narrow()) { setView('sheet'); return; } setSheet(true); centerOnFocus(true); }
function closeSheet() { if (narrow()) { setView('tree'); return; } setSheet(false); centerOnFocus(true); }
$('#tgSheet').onclick = function () { if (sheetOpen) closeSheet(); else openSheet(); };
$('#closeSheet').onclick = closeSheet;

function renderAll() { renderRegistry(); renderTree(); renderSheet(); }
function setFocus(id, open) {
  if (!P(id)) return;
  var same = vw.focus === id;
  vw.focus = id; persistView();
  if (!same) renderAll();
  if (open) openSheet(); else centerOnFocus(true);
}
function newPerson() {
  if (RO()) return;
  var id = Data.uid(db); db[id] = Data.blank(id); vw.focus = id; save(); renderAll();
  openSheet();
  var f = $('#f-prenom'); if (f) f.focus();
}
$('#add').onclick = newPerson;
$('#addFirst').onclick = newPerson;
$('#loadSeed').onclick = function () {
  if (RO() || ids().length) return;
  db = Data.seed().people; vw.focus = 'pierre'; save(); renderAll(); fit(false);
};
$('#anc').onchange = function () { vw.anc = +this.value; persistView(); renderTree(); fit(true); };
$('#desc').onchange = function () { vw.desc = +this.value; persistView(); renderTree(); fit(true); };

/* ====================================================================
   Données : export, import
   ==================================================================== */
function dmsg(t) { $('#dmsg').textContent = t; }
$('#exp').onclick = function () {
  var json = Data.serialize(db, sync ? sync.nom : '');
  var fail = function () { $('#imp').value = json; $('#imp').select(); dmsg('Copie refusée par le navigateur : le texte est sélectionné, copiez-le avec Ctrl+C.'); };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(json).then(function () { dmsg('JSON copié (' + ids().length + ' personnes).'); }, fail);
  else fail();
};
$('#impgo').onclick = function () {
  if (RO()) return;
  var n; try { n = Data.normalize(JSON.parse($('#imp').value)); } catch (e) { n = null; }
  if (!n) { dmsg('JSON invalide : l\'arbre n\'a pas été modifié.'); return; }
  arm($('#impgo'), 'Confirmer : remplacer tout l\'arbre', function () {
    db = n.people; fixFocus(); save(); renderAll(); fit(false);
    $('#imp').value = ''; dmsg('Arbre importé (' + ids().length + ' personnes).');
  });
};

/* ====================================================================
   Menu des arbres
   ==================================================================== */
function closeMenu() { $('#treeMenu').hidden = true; $('#treeBtn').setAttribute('aria-expanded', 'false'); }
$('#treeBtn').onclick = function (e) {
  e.stopPropagation();
  var m = $('#treeMenu');
  if (!m.hidden) { closeMenu(); return; }
  m.innerHTML = S.trees.map(function (t, i) {
    return '<button type="button" data-i="' + i + '"' + (sync && t.repo === sync.entry.repo ? ' class="cur"' : '') + '>' + esc(t.nom || t.repo) + '</button>';
  }).join('') + '<hr><button type="button" data-act="add">Ajouter un autre arbre…</button>'
    + '<button type="button" data-act="leave">Quitter cet arbre sur cet appareil</button>';
  m.hidden = false; $('#treeBtn').setAttribute('aria-expanded', 'true');
};
$('#treeMenu').addEventListener('click', function (e) {
  e.stopPropagation();
  var b = e.target.closest('button'); if (!b) return;
  var i = b.getAttribute('data-i'), act = b.getAttribute('data-act');
  if (i !== null) { closeMenu(); openTree(S.trees[+i].repo); }
  else if (act === 'add') { closeMenu(); goWelcome(); }
  else if (act === 'leave') {
    arm(b, 'Confirmer : retirer cet arbre d\'ici', function () {
      var repo = sync.entry.repo;
      try { localStorage.removeItem(viewKey(repo)); } catch (x) { }
      S.trees = S.trees.filter(function (t) { return t.repo !== repo; });
      sync = null; db = {}; S.current = S.trees.length ? S.trees[0].repo : null; saveStore();
      closeMenu();
      if (S.current) openTree(S.current); else goWelcome();
    });
  }
});
document.addEventListener('click', function (e) { if (!e.target.closest('.menuwrap')) closeMenu(); });

/* ====================================================================
   Partage
   ==================================================================== */
function modalOpen() { return !$('#shareModal').hidden; }
function closeModal() { $('#shareModal').hidden = true; }
$('#shareClose').onclick = closeModal;
$('#shareModal').addEventListener('mousedown', function (e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (modalOpen()) closeModal();
  else if (!$('#treeMenu').hidden) closeMenu();
  else if (sheetOpen && !narrow() && !$('#app').hidden) closeSheet();
});
$('#shareBtn').onclick = function () { openShare(false); };

function copyText(text, el, okMsg) {
  var fail = function () { var ta = el.closest('div').querySelector('textarea'); if (ta) { ta.select(); } el.textContent = 'Sélectionné : Ctrl+C'; };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(text).then(function () { var o = el.textContent; el.textContent = okMsg; setTimeout(function () { el.textContent = o; }, 1800); }, fail);
  else fail();
}
function inviteLink(code) { return location.href.split('#')[0] + '#' + code; }
function codeBlock(id, code, note) {
  return '<div><textarea id="' + id + '" rows="4" readonly aria-label="Code du groupe">' + esc(code) + '</textarea>'
    + '<div class="row-actions"><button type="button" class="btn primary" data-copy="' + id + '">Copier le code</button>'
    + '<button type="button" class="btn" data-copylink="' + id + '">Copier le lien d\'invitation</button></div>'
    + (note ? '<p class="help">' + note + '</p>' : '') + '</div>';
}
function openShare(first) {
  if (!sync) return;
  var e = sync.entry, editor = e.mode === 'e';
  var code = GH.makeCode({ repo: e.repo, token: e.token, nom: sync.nom || e.nom, mode: e.mode });
  var h = '';
  if (first) h += '<p class="help"><strong>L\'arbre est créé.</strong> Envoyez le code ci-dessous aux personnes du groupe : elles pourront l\'ouvrir et le modifier sans compte GitHub.</p>';
  h += '<h3>' + (editor ? 'Code du groupe (modification)' : 'Code de lecture seule') + '</h3>';
  h += codeBlock('sh-code', code, editor
    ? 'Ce code contient le jeton : toute personne qui l\'a peut modifier l\'arbre. Transmettez-le comme un mot de passe (messagerie privée, pas de publication).'
    : 'Ce code permet de consulter l\'arbre, pas de le modifier.');
  if (editor) {
    h += '<h3>Code en lecture seule</h3><p class="help">Pour des personnes qui ne doivent que consulter : créez un second jeton limité à la lecture.</p>'
      + '<div class="row-actions"><a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(GH.tokenUrl(e.repo.split('/')[0], 'r', 'Génialogie (lecture) - ' + (sync.nom || e.repo))) + '">Créer un jeton en lecture</a></div>'
      + '<label for="sh-rotoken">Jeton en lecture<input id="sh-rotoken" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>'
      + '<div class="row-actions"><button type="button" class="btn" id="sh-romake">Fabriquer le code en lecture seule</button></div>'
      + '<p id="sh-romsg" class="msg" role="status"></p><div id="sh-rocode"></div>';
  }
  h += '<h3>Remplacer le jeton</h3><p class="help">À faire si le jeton a expiré ou été refusé. Collez le nouveau jeton, ou un nouveau code de groupe de cet arbre.</p>'
    + '<div class="row-actions"><a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(GH.tokenUrl(e.repo.split('/')[0], e.mode, 'Génialogie - ' + (sync.nom || e.repo))) + '">Créer un nouveau jeton</a></div>'
    + '<label for="sh-newtoken">Nouveau jeton ou code<input id="sh-newtoken" type="password" autocomplete="off" spellcheck="false"></label>'
    + '<div class="row-actions"><button type="button" class="btn" id="sh-swap">Remplacer</button></div><p id="sh-swapmsg" class="msg" role="status"></p>';
  $('#shareTitle').textContent = 'Partager l\'arbre';
  $('#shareBody').innerHTML = h;
  $('#shareModal').hidden = false;
  $('#shareClose').focus();
}
$('#shareBody').addEventListener('click', function (ev) {
  var t = ev.target.closest('button'); if (!t || !sync) return;
  var e = sync.entry;
  var c = t.getAttribute('data-copy'), cl = t.getAttribute('data-copylink');
  if (c) { copyText($('#' + c).value, t, 'Copié'); return; }
  if (cl) { copyText(inviteLink($('#' + cl).value), t, 'Lien copié'); return; }
  if (t.id === 'sh-romake') {
    var msg = $('#sh-romsg'), tok = GH.cleanToken($('#sh-rotoken').value);
    if (!tok) { setMsg(msg, 'Collez le jeton en lecture (il commence par github_pat_).', true); return; }
    if (tok === e.token) { setMsg(msg, 'C\'est le jeton de modification : créez-en un autre, limité à la lecture.', true); return; }
    t.disabled = true; setMsg(msg, 'Vérification…');
    GH.getRepo(tok, e.repo).then(function (info) {
      if (info.canPush !== false) throw new Error('Ce jeton permet aussi d\'écrire : à la création, choisissez « Read-only » pour Contents.');
      var code = GH.makeCode({ repo: e.repo, token: tok, nom: sync.nom || e.nom, mode: 'r' });
      setMsg(msg, 'Code prêt.'); $('#sh-rocode').innerHTML = codeBlock('sh-rocode-t', code, 'Ce code ouvre l\'arbre en lecture seule.');
      $('#sh-rotoken').value = '';
    }).then(null, function (x) { setMsg(msg, x.message, true); }).then(function () { t.disabled = false; });
  } else if (t.id === 'sh-swap') {
    var m2 = $('#sh-swapmsg'), v = $('#sh-newtoken').value.trim(), nt;
    try {
      if (/^GEN1-/.test(v)) {
        var cc = GH.readCode(v);
        if (cc.repo.toLowerCase() !== e.repo.toLowerCase()) throw new Error('Ce code correspond à un autre dépôt (' + cc.repo + ').');
        nt = cc.token;
      } else nt = GH.cleanToken(v);
      if (!nt) throw new Error('Jeton vide ou incomplet : il commence par github_pat_.');
    } catch (x) { setMsg(m2, x.message, true); return; }
    t.disabled = true; setMsg(m2, 'Vérification…');
    GH.getRepo(nt, e.repo).then(function (info) {
      e.token = nt; e.mode = info.canPush === false ? 'r' : 'e'; e.exp = info.exp || null; saveStore();
      sync.authFail = false; sync.readonly = e.mode === 'r'; applyRO(); renderAll(); clearBanner();
      setMsg(m2, 'Jeton remplacé.'); $('#sh-newtoken').value = '';
      refresh(true);
      setTimeout(function () { if (modalOpen()) openShare(false); }, 700);
    }).then(null, function (x) { setMsg(m2, x.message, true); }).then(function () { t.disabled = false; });
  }
});

/* ====================================================================
   Démarrage
   ==================================================================== */
loadStore();
applyTheme(); applyCols();
(function start() {
  var h = location.hash.replace(/^#/, '');
  if (/^GEN1-/.test(h)) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
    $('#joinCode').value = h; $('#joinName').value = S.user; setMsg($('#joinMsg'), '');
    renderWelcome(); showScreen('join');
    return;
  }
  if (S.current && findTree(S.current)) openTree(S.current);
  else if (S.trees.length) openTree(S.trees[0].repo);
  else goWelcome();
})();
})();
