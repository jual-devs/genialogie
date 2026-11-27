/* Génialogie : accès à GitHub (API « Contents ») et codes de groupe.
   Le fichier arbre.json d'un dépôt privé sert de base de données.
   Fonctionne dans le navigateur (variable globale GH) et dans les tests Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.GH = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var API = 'https://api.github.com';
  var PATH = 'arbre.json';
  var CODE_PREFIX = 'GEN1-';
  var OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  var NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
  var TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

  /* ---------- base64 (UTF-8) ---------- */
  function b64enc(text) {
    var bytes = new TextEncoder().encode(text), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function b64urlEnc(text) { return b64enc(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64urlDec(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return b64dec(s);
  }

  /* ---------- dépôt : adresse saisie par l'utilisateur ---------- */
  function parseRepo(input) {
    var s = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^github\.com\//i, '');
    var parts = s.split(/[\/?#]/);
    var owner = parts[0], name = (parts[1] || '').replace(/\.git$/i, '');
    if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return null;
    return { owner: owner, name: name, full: owner + '/' + name };
  }
  function slug(nom) {
    var s = String(nom || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
    return 'genialogie-' + (s || 'famille');
  }

  /* ---------- code de groupe ---------- */
  function makeCode(o) {
    return CODE_PREFIX + b64urlEnc(JSON.stringify({ r: o.repo, t: o.token, n: o.nom || '', m: o.mode === 'r' ? 'r' : 'e' }));
  }
  function readCode(input) {
    var s = String(input || '').replace(/\s+/g, '');
    if (s.indexOf(CODE_PREFIX) !== 0) throw new Error('Ce code n\'est pas valide : il doit commencer par GEN1-.');
    var o;
    try { o = JSON.parse(b64urlDec(s.slice(CODE_PREFIX.length))); }
    catch (e) { throw new Error('Ce code est incomplet ou abîmé. Copiez-le en entier.'); }
    var repo = o && typeof o.r === 'string' ? parseRepo(o.r) : null;
    if (!repo || typeof o.t !== 'string' || !TOKEN_RE.test(o.t)) throw new Error('Ce code est incomplet ou abîmé. Copiez-le en entier.');
    return { repo: repo.full, token: o.t, nom: typeof o.n === 'string' ? o.n.slice(0, 100) : '', mode: o.m === 'r' ? 'r' : 'e' };
  }
  function cleanToken(input) {
    var t = String(input || '').trim();
    return TOKEN_RE.test(t) ? t : null;
  }

  /* ---------- adresses GitHub pré-remplies ---------- */
  function enc(s) { return encodeURIComponent(s); }
  function newRepoUrl(name, description) {
    return 'https://github.com/new?name=' + enc(name) + '&description=' + enc(description) + '&visibility=private';
  }
  function tokenUrl(owner, mode, name) {
    return 'https://github.com/settings/personal-access-tokens/new?name=' + enc(name) +
      '&description=' + enc('Accès à un arbre Génialogie') + (owner ? '&target_name=' + enc(owner) : '') +
      '&expires_in=365&contents=' + (mode === 'r' ? 'read' : 'write');
  }
  function expiryDays(exp) {
    if (!exp) return null;
    var t = Date.parse(String(exp).replace(' UTC', 'Z').replace(' ', 'T'));
    return isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000);
  }

  /* ---------- requêtes ---------- */
  function httpError(status, data) {
    var m = data && data.message ? String(data.message) : '';
    var text;
    if (status === 0) text = 'Pas de connexion à GitHub.';
    else if (status === 401) text = 'Le jeton est refusé ou a expiré.';
    else if (status === 403 && /rate limit/i.test(m)) text = 'Limite de requêtes GitHub atteinte : réessayez dans quelques minutes.';
    else if (status === 403) text = 'Ce jeton n\'a pas le droit d\'écrire dans ce dépôt (code en lecture seule ?).';
    else if (status === 404) text = 'Dépôt introuvable, ou le jeton n\'y donne pas accès.';
    else if (status === 409 || status === 422) text = 'Quelqu\'un d\'autre a modifié l\'arbre en même temps.';
    else text = 'GitHub a répondu : ' + (m || status) + '.';
    var e = new Error(text);
    e.status = status;
    e.conflict = status === 409 || status === 422;
    e.detail = m;
    return e;
  }
  function request(token, method, path, body, accept) {
    var headers = { 'Accept': accept || 'application/vnd.github+json', 'Authorization': 'Bearer ' + token };
    var opt = { method: method, headers: headers, cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var f = (root && root.fetch) ? root.fetch.bind(root) : fetch;
    return f(API + path, opt).then(function (r) {
      var exp = r.headers.get('github-authentication-token-expiration');
      var raw = accept && /raw/.test(accept) && r.ok;
      return (raw ? r.text() : r.json().catch(function () { return {}; })).then(function (data) {
        if (!r.ok) throw httpError(r.status, data);
        return { data: data, exp: exp };
      });
    }, function () { throw httpError(0, {}); });
  }
  function filePath(repo, path) { return '/repos/' + repo + '/contents/' + path.split('/').map(enc).join('/'); }

  function getRepo(token, repo) {
    return request(token, 'GET', '/repos/' + repo).then(function (r) {
      var p = r.data.permissions;
      return { full: r.data.full_name || repo, isPrivate: !!r.data.private, exp: r.exp,
        canPush: p ? !!(p.push || p.admin || p.maintain) : null };
    });
  }
  /* renvoie { sha, text, exp } ou null si le fichier n'existe pas */
  function getFile(token, repo, path) {
    return request(token, 'GET', filePath(repo, path)).then(function (r) {
      var d = r.data;
      if (Array.isArray(d) || !d || !d.sha) throw httpError(0, { message: path + ' n\'est pas un fichier' });
      if (d.encoding === 'base64' && typeof d.content === 'string' && d.content !== '') return { sha: d.sha, text: b64dec(d.content), exp: r.exp };
      if (d.size === 0) return { sha: d.sha, text: '', exp: r.exp };
      return request(token, 'GET', filePath(repo, path), undefined, 'application/vnd.github.raw+json').then(function (r2) {
        return { sha: d.sha, text: r2.data, exp: r.exp };
      });
    }, function (e) { if (e.status === 404) return null; throw e; });
  }
  function putFile(token, repo, path, text, sha, message) {
    var body = { message: message, content: b64enc(text) };
    if (sha) body.sha = sha;
    return request(token, 'PUT', filePath(repo, path), body).then(function (r) {
      return { sha: r.data.content.sha, exp: r.exp };
    });
  }

  return { PATH: PATH, makeCode: makeCode, readCode: readCode, cleanToken: cleanToken, parseRepo: parseRepo, slug: slug,
    newRepoUrl: newRepoUrl, tokenUrl: tokenUrl, expiryDays: expiryDays, getRepo: getRepo, getFile: getFile,
    putFile: putFile, b64enc: b64enc, b64dec: b64dec };
});
