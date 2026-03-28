window.KSE = window.KSE || {};
(function(){
  function id(n){ return document.getElementById(n); }

  async function getApiBase(){
    var apiBase = document.querySelector('meta[name="api-base"]')?.content || (window.KSE && window.KSE.apiBase) || '';
    if(!apiBase && window.KSE && window.KSE.fragmentsReady){
      try { await window.KSE.fragmentsReady; } catch(e){}
      apiBase = document.querySelector('meta[name="api-base"]')?.content || (window.KSE && window.KSE.apiBase) || '';
    }
    return apiBase ? apiBase.replace(/\/$/, '') : '';
  }

  async function postJson(url, body){
    var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    var data = {};
    try{ data = await res.json(); }catch(e){}
    return { status: res.status, ok: res.ok, data: data };
  }

  async function setupSocialHrefs(){
    try{
      var base = await getApiBase();
      var ghHref = base ? base + '/api/v1/acc/oauth/github' : '/api/v1/acc/oauth/github';
      var googleHref = base ? base + '/api/v1/acc/oauth/google' : '/api/v1/acc/oauth/google';
      var hackHref = base ? base + '/api/v1/acc/oauth/hack_club' : '/api/v1/acc/oauth/hack_club';
      var ghBtn = document.getElementById('github-login'); if(ghBtn) ghBtn.href = ghHref;
      var gBtn = document.getElementById('google-login'); if(gBtn) gBtn.href = googleHref;
      var hBtn = document.getElementById('hackclub-login'); if(hBtn) hBtn.href = hackHref;
    }catch(e){}
  }

  function showMessage(elem, text, isHtml){
    if(!elem) return;
    if(isHtml) elem.innerHTML = text;
    else elem.textContent = text;
  }

  function saveSecret(secret){
    try { localStorage.setItem('kse_secret', secret); } catch(e){}
  }

  async function initLogin(opts){
    opts = opts || {};
    var form = document.getElementById(opts.formId || 'login-form');
    var msg = document.getElementById(opts.messageId || 'message');
    if(!form) return;
    setupSocialHrefs().catch(()=>{});

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      showMessage(msg, '');
      var email = (document.getElementById('email')?.value || '').trim();
      var password = (document.getElementById('password')?.value || '');
      if(!email || !password){ showMessage(msg, 'Email and password are required'); return; }
      var base = await getApiBase();
      var url = base ? base + '/api/v1/acc/login' : '/api/v1/acc/login';
      try{
        var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password }) });
        var json = await res.json().catch(()=>{return {}});
        if(res.ok && json && json.secret){
          saveSecret(json.secret);
          showMessage(msg, 'Login successful. Redirecting...');
          setTimeout(function(){ window.location.href = opts.redirect || '/acc/dashboard/'; }, 600);
          return;
        }

        if(res.status === 403 && json && json.resend){
          var resendEndpoint = json.resend_endpoint || '/api/v1/acc/resend_confirmation';
          var resendUrl = base ? base + resendEndpoint : resendEndpoint;
          showMessage(msg, '');
          var html = '<div class="muted">Email not confirmed. <button id="resend-btn" class="btn-ghost">Resend confirmation</button></div>';
          showMessage(msg, html, true);
          var resendBtn = document.getElementById('resend-btn');
          if(resendBtn){
            resendBtn.addEventListener('click', async function(){
              resendBtn.disabled = true;
              try{
                var rr = await fetch(resendUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
                if(rr.ok){ showMessage(msg, 'Confirmation email resent.'); }
                else { var ej = await rr.json().catch(()=>{}); showMessage(msg, ej && ej.error ? ej.error : 'Failed to resend'); }
              }catch(ex){ showMessage(msg, 'Network error while resending'); }
            });
          }
          return;
        }

        showMessage(msg, 'Login error: ' + (json && json.error ? json.error : 'Login failed'));
      }catch(err){ console.error(err); showMessage(msg, 'Login error: ' + (err.message || err)); }
    });
  }

  async function initRegister(opts){
    opts = opts || {};
    var form = document.getElementById(opts.formId || 'register-form');
    var msg = document.getElementById(opts.messageId || 'message');
    if(!form) return;
    setupSocialHrefs().catch(()=>{});

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      showMessage(msg, '');
      var name = (document.getElementById('name')?.value || '').trim();
      var email = (document.getElementById('email')?.value || '').trim();
      var password = (document.getElementById('password')?.value || '');
      if(!email || !password){ showMessage(msg, 'Email and password are required'); return; }
      var base = await getApiBase();
      var url = base ? base + '/api/v1/acc/register' : '/api/v1/acc/register';
      try{
        var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, email: email, password: password }) });
        var json = await res.json().catch(()=>{return {}});
        if(res.status === 201 && json && json.secret){
          saveSecret(json.secret);
          showMessage(msg, 'Registration successful. Redirecting...');
          setTimeout(function(){ window.location.href = opts.redirect || '/acc/dashboard/'; }, 900);
          return;
        }
        if(res.status === 201 && (json && (json.ok || json.message))){
          showMessage(msg, json.message || 'Registration successful — confirmation email sent.');
          setTimeout(function(){ window.location.href = opts.verifyRedirect || '/verify_email.html'; }, 900);
          return;
        }
        showMessage(msg, 'Registration error: ' + (json && json.error ? json.error : 'Registration failed'));
      }catch(err){ console.error(err); showMessage(msg, 'Registration error: ' + (err.message || err)); }
    });
  }

  window.KSE.auth = { id: id, getApiBase: getApiBase, postJson: postJson, setupSocialHrefs: setupSocialHrefs, initLogin: initLogin, initRegister: initRegister, showMessage: showMessage };
})();
