/* =====================================================================
   TOUNI RETOUR — couche de réparations (diagnostic)  — additive, sûre.
   Chargée sur toutes les pages. Corrige : messages d'erreur bruts,
   états de chargement, a11y (labels, meta), images (lazy), polish.
   ===================================================================== */
(function () {
  'use strict';
  function ready(fn){ if(document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded',fn); }

  /* ---------- 1) Meta : color-scheme + theme-color ---------- */
  function injectMeta(){
    try{
      if(!document.querySelector('meta[name="color-scheme"]')){
        var m=document.createElement('meta'); m.name='color-scheme'; m.content='light'; document.head.appendChild(m);
      }
      if(!document.querySelector('meta[name="theme-color"]')){
        var t=document.createElement('meta'); t.name='theme-color'; t.content='#0e1016'; document.head.appendChild(t);
      }
    }catch(e){}
  }

  /* ---------- 2) Messages d'erreur : technique -> humain + Réessayer ---------- */
  var ERR_RX=/(unexpected token|is not valid json|failed to fetch|networkerror|json\.parse|<!doctype)/i;
  function humaniseError(el){
    try{
      if(!el || el.__tnrDone) return;
      var txt=(el.textContent||'').trim();
      if(txt.length>200 || !ERR_RX.test(txt)) return;
      // seulement les petits blocs d'erreur (souvent préfixés ⚠️)
      if(el.children.length>3) return;
      el.__tnrDone=true;
      el.innerHTML='';
      var wrap=document.createElement('div'); wrap.className='tnr-error';
      wrap.innerHTML='<div style="font-size:26px">⚠️</div>'
        +'<b>Impossible de charger les données</b>'
        +'<span>Vérifie ta connexion internet, puis réessaie.</span>';
      var btn=document.createElement('button'); btn.className='tnr-retry'; btn.type='button';
      btn.textContent='Réessayer'; btn.onclick=function(){ location.reload(); };
      wrap.appendChild(btn);
      el.appendChild(wrap);
    }catch(e){}
  }
  function scanErrors(root){
    try{
      var nodes=(root||document.body).querySelectorAll('div,p,span,section');
      for(var i=0;i<nodes.length;i++){
        var n=nodes[i];
        if(n.children.length<=3 && ERR_RX.test(n.textContent||'')) humaniseError(n);
      }
    }catch(e){}
  }

  /* ---------- 3) "Chargement..." -> "Chargement…" ---------- */
  function fixEllipsis(root){
    try{
      var w=document.createTreeWalker(root||document.body,NodeFilter.SHOW_TEXT,null);
      var n, list=[];
      while((n=w.nextNode())){ if(n.nodeValue && n.nodeValue.indexOf('...')>=0) list.push(n); }
      list.forEach(function(t){ t.nodeValue=t.nodeValue.replace(/\.\.\./g,'…'); });
    }catch(e){}
  }

  /* ---------- 4) a11y : labels sur boutons icônes ---------- */
  var ICON_LABELS={'🔔':'Notifications','☰':'Menu','×':'Fermer','✕':'Fermer','✏️':'Modifier','✏':'Modifier',
    '🔄':'Synchroniser','↩':'Déconnexion','⚙️':'Réglages','⚙':'Réglages','📸':'Sauvegarder','🗑':'Supprimer','🗑️':'Supprimer','↻':'Actualiser','⟳':'Actualiser'};
  function labelIconButtons(root){
    try{
      var btns=(root||document).querySelectorAll('button:not([aria-label]),a:not([aria-label]),[role="button"]:not([aria-label]),[onclick]:not([aria-label])');
      for(var i=0;i<btns.length;i++){
        var b=btns[i];
        if(b.getAttribute('aria-label')) continue;
        if(b.querySelector && b.querySelector('button,a')) continue; // conteneur, pas un bouton feuille
        if(b.title){ b.setAttribute('aria-label',b.title); continue; }
        // icône seule : on retire chiffres/espaces (ex. cloche "🔔0" -> "🔔")
        var t=(b.textContent||'').replace(/[\s\d]+/g,'').trim();
        if(t && t.length<=2){
          var lab=ICON_LABELS[t]||ICON_LABELS[t.charAt(0)];
          if(lab) b.setAttribute('aria-label',lab);
        }
      }
    }catch(e){}
  }

  /* ---------- 5) Images : lazy + decoding + éviter le saut de layout ---------- */
  function improveImages(root){
    try{
      var imgs=(root||document).querySelectorAll('img:not([data-tnr])');
      for(var i=0;i<imgs.length;i++){
        var im=imgs[i]; im.setAttribute('data-tnr','1');
        if(!im.getAttribute('loading')) im.setAttribute('loading','lazy');
        if(!im.getAttribute('decoding')) im.setAttribute('decoding','async');
        if(!im.getAttribute('alt')) im.setAttribute('alt','');
      }
    }catch(e){}
  }

  /* ---------- 6) Inputs : autocomplete raisonnable ---------- */
  function fixInputs(){
    try{
      var ins=document.querySelectorAll('input:not([data-tnr])');
      for(var i=0;i<ins.length;i++){
        var el=ins[i]; el.setAttribute('data-tnr','1');
        var ty=(el.type||'text').toLowerCase();
        if(ty==='password'){ if(!el.getAttribute('autocomplete')) el.setAttribute('autocomplete','current-password'); }
        else if(!el.getAttribute('autocomplete')) el.setAttribute('autocomplete','off');
        if((el.name||'').match(/qty|quantit|num|count/i) && !el.getAttribute('inputmode')) el.setAttribute('inputmode','numeric');
      }
    }catch(e){}
  }

  function pass(root){ scanErrors(root); fixEllipsis(root); labelIconButtons(root); improveImages(root); }

  ready(function(){
    injectMeta(); fixInputs(); pass(document);
    // suivre les contenus injectés dynamiquement (tables, erreurs, notifs)
    try{
      var mo=new MutationObserver(function(muts){
        for(var i=0;i<muts.length;i++){
          var m=muts[i];
          if(m.type==='characterData'){
            var p=m.target && m.target.parentElement;
            if(p && ERR_RX.test(p.textContent||'')) humaniseError(p);
            continue;
          }
          for(var j=0;j<m.addedNodes.length;j++){
            var nd=m.addedNodes[j];
            if(nd.nodeType===1){ pass(nd); }
            else if(nd.nodeType===3 && nd.parentElement && ERR_RX.test(nd.parentElement.textContent||'')) humaniseError(nd.parentElement);
          }
        }
      });
      mo.observe(document.body,{childList:true,subtree:true,characterData:true});
    }catch(e){}
    // filets de sécurité : erreurs/chargements arrivent souvent APRÈS le fetch
    [600,1500,3000].forEach(function(t){ setTimeout(function(){ scanErrors(document); fixEllipsis(document); labelIconButtons(document); },t); });
  });
})();
