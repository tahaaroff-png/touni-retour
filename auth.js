/* Code d'accès Touni : demandé une seule fois par appareil/navigateur, puis mémorisé (localStorage). Aucun mot de passe n'est écrit dans les pages. */
(function () {
  var K = 'touni_key';
  function get() { try { return localStorage.getItem(K) || ''; } catch (e) { return ''; } }
  window.touniKey = function () {
    var k = get();
    if (!k) {
      k = (window.prompt("Code d'accès Touni (donné par la direction) :") || '').trim();
      if (k) { try { localStorage.setItem(K, k); } catch (e) {} }
    }
    return k;
  };
  // Si l'API refuse le code (401) : on l'efface et on recharge une fois pour le redemander.
  var of = window.fetch;
  if (of) {
    window.fetch = function () {
      var a = arguments, had = !!get();
      return of.apply(this, a).then(function (r) {
        try {
          var u = String((a[0] && a[0].url) || a[0] || '');
          if (r && r.status === 401 && had && u.indexOf('/api/') >= 0 && !window.__touniReload) {
            window.__touniReload = 1; try { localStorage.removeItem(K); } catch (e) {}
            setTimeout(function () { alert("Code d'accès incorrect ou expiré. Entre le nouveau code."); location.reload(); }, 50);
          }
        } catch (e) {}
        return r;
      });
    };
  }
})();
