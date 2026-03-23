(async function(){
  // determine base path relative to this script
  var script = document.currentScript || (function(){var s=document.getElementsByTagName('script'); return s[s.length-1];})();
  var scriptSrc = script && script.src ? script.src : '';
  var base = '/';
  var m = scriptSrc.match(/^(.*)\/js\/[\w._-]+\.js(\?.*)?$/);
  if(m) base = m[1] + '/';

  async function loadFragment(name, containerId, wrapTag){
    try{
      var res = await fetch(base + name);
      if(!res.ok) return;
      var txt = await res.text();
      var el = document.getElementById(containerId);
      if(!el) return;
      if(wrapTag) {
        var wrapperClass = (wrapTag === 'header') ? 'site-header' : (wrapTag === 'footer' ? 'site-footer' : wrapTag + '-wrapper');
        el.innerHTML = '<'+wrapTag+' class="' + wrapperClass + '">' + txt + '</'+wrapTag+'>';
      } else el.innerHTML = txt;
    }catch(e){ console.error('loadFragment', name, e); }
  }

  await loadFragment('header.html', 'site-header', 'header');
  await loadFragment('footer.html', 'site-footer', 'footer');

  try{ var y = document.getElementById('site-year'); if(y) y.textContent = new Date().getFullYear(); }catch(e){}

  try{
    var ai = document.getElementById('auth-indicator');
    var secret = null;
    try{ secret = localStorage.getItem('kse_secret'); }catch(e){}
    if(ai){
      if(secret){
        ai.style.display = 'inline-flex';
        ai.textContent = 'Logged in';
        var btn = document.createElement('button'); btn.textContent='Logout'; btn.className='btn-ghost'; btn.style.marginLeft='8px';
        btn.addEventListener('click', function(){ try{ localStorage.removeItem('kse_secret'); }catch(e){}; window.location.reload(); });
        ai.appendChild(btn);
      } else {
        ai.style.display = 'none';
        ai.innerHTML = '';
      }
    }

    // nav auth link
    try{
      var navAuth = document.getElementById('nav-auth-link');
      if(navAuth){
        if(secret){ navAuth.innerHTML = '<a href="/acc/dashboard/" class="nav-cta">Dashboard</a>'; }
        else { navAuth.innerHTML = '<a href="/acc/login/" class="nav-link">Log in</a>'; }
      }
    }catch(e){}
  }catch(e){ console.error(e); }
})();
