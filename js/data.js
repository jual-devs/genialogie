/* Génialogie : modèle de données, comparaison et fusion des modifications.
   Aucune dépendance : le même fichier sert dans le navigateur (variable globale Data) et dans les tests Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Data = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var TEXT_MAX = 200;
  var FIELDS = ['prenom', 'nom', 'profession',
    'naissance.date', 'naissance.lieu', 'mariage.date', 'mariage.lieu', 'deces.date', 'deces.lieu'];

  function str(v) { return typeof v === 'string' ? v.slice(0, TEXT_MAX) : ''; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(people) {
    var max = 0;
    Object.keys(people || {}).forEach(function (id) {
      var m = /^p(\d+)(?:-|$)/.exec(id);
      if (m && +m[1] > max) max = +m[1];
    });
    var r = '';
    while (r.length < 3) r += Math.random().toString(36).slice(2);
    return 'p' + (Math.max(max, Object.keys(people || {}).length) + 1) + '-' + r.slice(0, 3);
  }
  function blank(id) {
    return { id: id, prenom: '', nom: '', profession: '',
      naissance: { date: '', lieu: '' }, mariage: { date: '', lieu: '' }, deces: { date: '', lieu: '' },
      conjoints: [], parents: [] };
  }
  function getF(p, k) { var s = k.split('.'); return s[1] ? p[s[0]][s[1]] : p[k]; }
  function setF(p, k, v) { var s = k.split('.'); if (s[1]) p[s[0]][s[1]] = v; else p[k] = v; }

  /* ---------- lecture d'un fichier arbre.json (contenu non fiable) ---------- */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !raw.people || typeof raw.people !== 'object') return null;
    var people = {};
    Object.keys(raw.people).forEach(function (id) {
      if (!ID_RE.test(id)) return;
      var r = raw.people[id] || {}, p = blank(id);
      ['prenom', 'nom', 'profession'].forEach(function (k) { p[k] = str(r[k]); });
      ['naissance', 'mariage', 'deces'].forEach(function (k) {
        var e = r[k] || {};
        p[k] = { date: str(e.date), lieu: str(e.lieu) };
      });
      p.conjoints = Array.isArray(r.conjoints) ? r.conjoints.filter(function (x) { return typeof x === 'string'; }) : [];
      p.parents = Array.isArray(r.parents) ? r.parents.filter(function (x) { return typeof x === 'string'; }) : [];
      people[id] = p;
    });
    Object.keys(people).forEach(function (id) {
      var p = people[id];
      p.parents = uniq(p.parents.filter(function (i) { return people[i] && i !== id; })).slice(0, 2);
      p.conjoints = uniq(p.conjoints.filter(function (i) { return people[i] && i !== id; }));
    });
    Object.keys(people).forEach(function (id) {       // les couples sont toujours symétriques
      people[id].conjoints.forEach(function (o) {
        if (people[o].conjoints.indexOf(id) < 0) people[o].conjoints.push(id);
      });
    });
    Object.keys(people).forEach(function (id) { people[id].conjoints.sort(); });
    return { nom: str(raw.nom), people: people };
  }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  /* ---------- écriture : texte stable pour que Git ne montre que les vrais changements ---------- */
  function serialize(people, nom) {
    var out = {};
    Object.keys(people).sort().forEach(function (id) {
      var p = people[id];
      out[id] = { id: id, prenom: p.prenom, nom: p.nom, profession: p.profession,
        naissance: p.naissance, mariage: p.mariage, deces: p.deces,
        conjoints: p.conjoints.slice().sort(), parents: p.parents.slice() };
    });
    return JSON.stringify({ version: 1, nom: nom || '', people: out }, null, 1) + '\n';
  }

  /* ---------- comparaison : ce que l'utilisateur a changé depuis la dernière version connue ---------- */
  function pairSet(people, kind) {
    var s = {};
    Object.keys(people).forEach(function (id) {
      people[id][kind].forEach(function (o) {
        if (kind === 'parents') s[id + '|' + o] = 1;
        else s[id < o ? id + '|' + o : o + '|' + id] = 1;
      });
    });
    return s;
  }
  function diff(base, cur) {
    var ops = { add: [], del: [], set: [], parents_add: [], parents_del: [], unions_add: [], unions_del: [] };
    Object.keys(cur).forEach(function (id) {
      var c = cur[id], b = base[id];
      if (!b) { ops.add.push(clone(c)); return; }
      var f = {};
      FIELDS.forEach(function (k) { var v = getF(c, k); if (v !== getF(b, k)) f[k] = v; });
      if (Object.keys(f).length) ops.set.push({ id: id, f: f });
    });
    Object.keys(base).forEach(function (id) { if (!cur[id]) ops.del.push(id); });
    var gone = {};
    ops.del.forEach(function (id) { gone[id] = 1; });
    [['parents', 'parents'], ['unions', 'conjoints']].forEach(function (t) {
      var bs = pairSet(base, t[1]), cs = pairSet(cur, t[1]);
      Object.keys(cs).forEach(function (k) { if (!bs[k]) ops[t[0] + '_add'].push(k.split('|')); });
      Object.keys(bs).forEach(function (k) {
        var pr = k.split('|');
        if (!cs[k] && !gone[pr[0]] && !gone[pr[1]]) ops[t[0] + '_del'].push(pr);
      });
    });
    return ops;
  }
  function isEmpty(ops) {
    return !(ops.add.length || ops.del.length || ops.set.length || ops.parents_add.length ||
      ops.parents_del.length || ops.unions_add.length || ops.unions_del.length);
  }
  function count(ops) {
    return ops.add.length + ops.del.length + ops.set.length + ops.parents_add.length +
      ops.parents_del.length + ops.unions_add.length + ops.unions_del.length;
  }

  /* ---------- fusion : rejoue ces changements sur la version la plus récente du dépôt ---------- */
  function isAncOrSelf(people, x, a, seen) {
    seen = seen || {};
    if (x === a) return true;
    if (seen[x] || !people[x]) return false;
    seen[x] = 1;
    return people[x].parents.some(function (q) { return isAncOrSelf(people, q, a, seen); });
  }
  function applyOps(remote, ops, label) {
    var people = clone(remote), notes = [];
    label = label || function (id) { return id; };

    ops.del.forEach(function (id) {
      if (!people[id]) return;
      delete people[id];
      Object.keys(people).forEach(function (i) {
        people[i].parents = people[i].parents.filter(function (x) { return x !== id; });
        people[i].conjoints = people[i].conjoints.filter(function (x) { return x !== id; });
      });
    });
    ops.add.forEach(function (p) {
      var t = people[p.id] || (people[p.id] = blank(p.id));
      FIELDS.forEach(function (k) { setF(t, k, getF(p, k)); });
    });
    ops.parents_del.forEach(function (pr) {
      if (people[pr[0]]) people[pr[0]].parents = people[pr[0]].parents.filter(function (x) { return x !== pr[1]; });
    });
    ops.unions_del.forEach(function (pr) {
      if (people[pr[0]]) people[pr[0]].conjoints = people[pr[0]].conjoints.filter(function (x) { return x !== pr[1]; });
      if (people[pr[1]]) people[pr[1]].conjoints = people[pr[1]].conjoints.filter(function (x) { return x !== pr[0]; });
    });
    ops.set.forEach(function (s) {
      var p = people[s.id];
      if (!p) { notes.push('« ' + label(s.id) + ' » a été supprimée par quelqu\'un d\'autre : votre modification de cette fiche est ignorée.'); return; }
      Object.keys(s.f).forEach(function (k) { setF(p, k, s.f[k]); });
    });
    ops.parents_add.forEach(function (pr) {
      var c = pr[0], q = pr[1];
      if (!people[c] || !people[q]) return;
      if (people[c].parents.indexOf(q) >= 0) return;
      if (people[c].parents.length >= 2) { notes.push('« ' + label(c) + ' » a déjà deux parents : le lien avec « ' + label(q) + ' » n\'a pas été ajouté.'); return; }
      if (isAncOrSelf(people, q, c)) { notes.push('Le lien entre « ' + label(c) + ' » et « ' + label(q) + ' » créerait une boucle : il n\'a pas été ajouté.'); return; }
      people[c].parents.push(q);
    });
    ops.unions_add.forEach(function (pr) {
      var a = pr[0], b = pr[1];
      if (!people[a] || !people[b] || a === b) return;
      if (people[a].conjoints.indexOf(b) < 0) people[a].conjoints.push(b);
      if (people[b].conjoints.indexOf(a) < 0) people[b].conjoints.push(a);
    });
    Object.keys(people).forEach(function (id) { people[id].conjoints.sort(); });
    return { people: people, notes: notes };
  }

  function same(a, b) { return serialize(a, '') === serialize(b, ''); }

  /* ---------- famille d'exemple ---------- */
  function seed() {
    var people = {};
    function add(id, prenom, nom, job, n, m, d) {
      var p = blank(id); p.prenom = prenom; p.nom = nom; p.profession = job;
      p.naissance = { date: n[0], lieu: n[1] };
      p.mariage = { date: (m && m[0]) || '', lieu: (m && m[1]) || '' };
      p.deces = { date: (d && d[0]) || '', lieu: (d && d[1]) || '' };
      people[id] = p;
    }
    function wed(a, b) { people[a].conjoints.push(b); people[b].conjoints.push(a); }
    function kid(c, a, b) { people[c].parents = [a, b]; }
    add('emile', 'Émile', 'Dupont', 'laboureur', ['12/03/1890', 'Ath'], ['1913', 'Soignies'], ['1960', 'Ath']);
    add('berthe', 'Berthe', 'Mahieu', 'ménagère', ['1895', 'Soignies'], ['1913', 'Soignies'], ['1975', 'Ath']);
    add('louis', 'Louis', 'Lambert', 'instituteur', ['1896', 'Tournai'], ['1920', 'Tournai'], ['1970', 'Tournai']);
    add('jeanne', 'Jeanne', 'Dewit', 'sans profession', ['1899', 'Tournai'], ['1920', 'Tournai'], ['1981', 'Tournai']);
    add('joseph', 'Joseph', 'Dupont', 'boulanger', ['04/11/1921', 'Ath'], ['18/05/1946', 'Tournai'], ['22/01/1989', 'Mons']);
    add('marie', 'Marie', 'Lambert', 'couturière', ['1924', 'Tournai'], ['18/05/1946', 'Tournai'], ['2010', 'Mons']);
    add('henri', 'Henri', 'Martin', 'mécanicien', ['1922', 'Namur'], ['1947', 'Namur'], ['1995', 'Namur']);
    add('odile', 'Odile', 'Vandenberghe', 'employée de commerce', ['1925', 'Namur'], ['1947', 'Namur'], ['2008', 'Namur']);
    add('pierre', 'Pierre', 'Dupont', 'instituteur', ['09/02/1948', 'Mons'], ['14/09/1973', 'Namur']);
    add('claire', 'Claire', 'Martin', 'infirmière', ['1950', 'Namur'], ['14/09/1973', 'Namur']);
    add('anne', 'Anne', 'Dupont', 'pharmacienne', ['1951', 'Mons'], ['1975', 'Mons']);
    add('marc', 'Marc', 'Leroy', 'architecte', ['1949', 'Liège'], ['1975', 'Mons']);
    add('julien', 'Julien', 'Dupont', 'ingénieur', ['1976', 'Mons'], ['2005', 'Liège']);
    add('laura', 'Laura', 'Bernard', 'graphiste', ['1978', 'Liège'], ['2005', 'Liège']);
    add('sophie', 'Sophie', 'Dupont', 'médecin', ['1979', 'Mons']);
    add('thomas', 'Thomas', 'Leroy', 'photographe', ['1980', 'Mons']);
    add('lea', 'Léa', 'Dupont', '', ['2008', 'Mons']);
    wed('emile', 'berthe'); wed('louis', 'jeanne'); wed('joseph', 'marie'); wed('henri', 'odile');
    wed('pierre', 'claire'); wed('anne', 'marc'); wed('julien', 'laura');
    kid('joseph', 'emile', 'berthe'); kid('marie', 'louis', 'jeanne'); kid('claire', 'henri', 'odile');
    kid('pierre', 'joseph', 'marie'); kid('anne', 'joseph', 'marie');
    kid('julien', 'pierre', 'claire'); kid('sophie', 'pierre', 'claire'); kid('thomas', 'marc', 'anne');
    kid('lea', 'julien', 'laura');
    Object.keys(people).forEach(function (id) { people[id].conjoints.sort(); });
    return { nom: 'Famille d\'exemple', people: people };
  }

  return { ID_RE: ID_RE, FIELDS: FIELDS, blank: blank, uid: uid, clone: clone, normalize: normalize,
    serialize: serialize, diff: diff, isEmpty: isEmpty, count: count, applyOps: applyOps, same: same, seed: seed };
});
