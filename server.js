// ── REPLACE the entire subscribeMailchimp function in index.html ──
// Find:   const MAILCHIMP_LIST_ID=...  (the old variables, if any)
// And replace subscribeMailchimp with this version:

const SUBSCRIBE_URL = 'https://xeerhub-api-production.up.railway.app/subscribe';

async function subscribeMailchimp(source) {
  const ids = {
    popup:    { email: 'popupEmail',    btn: 'popupBtn',    success: 'newsletterSuccessPopup', form: 'newsletterFormPopup' },
    homepage: { email: 'homepageEmail', btn: 'homepageBtn', success: 'homepageSuccess',        form: 'homepageSignupForm'  },
    footer:   { email: 'footerEmail',   btn: 'footerBtn',   success: null,                     form: null                  },
    blog:     { email: 'blogEmail',     btn: 'blogBtn',     success: null,                     form: null                  },
  };

  const cfg     = ids[source];
  const emailEl = document.getElementById(cfg.email);
  const email   = emailEl ? emailEl.value.trim() : '';

  if (!email || !email.includes('@')) {
    showToast('Please enter a valid email', 'error');
    return;
  }

  const btn = document.getElementById(cfg.btn);
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

  try {
    const res  = await fetch(SUBSCRIBE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, source }),
    });

    const data = await res.json();

    if (data.status === 'subscribed') {
      showToast("You're already subscribed! 🎉", 'success');
      if (btn) { btn.disabled = false; btn.textContent = 'Subscribe →'; }
      return;
    }

    // pending or any other status = treat as success
    handleSuccess(source, cfg, emailEl, btn);

  } catch (err) {
    console.error('[subscribe]', err);
    showToast('Could not connect. Please try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Subscribe →'; }
  }
}

function handleSuccess(source, cfg, emailEl, btn) {
  localStorage.setItem('xeerhub_subscribed', '1');
  dismissNewsletter();

  if (source === 'popup') {
    document.getElementById(cfg.form).style.display    = 'none';
    document.getElementById(cfg.success).style.display = 'block';
    setTimeout(() => closeModal('newsletter'), 2500);
  } else if (source === 'homepage') {
    document.getElementById(cfg.form).style.display    = 'none';
    document.getElementById(cfg.success).style.display = 'block';
  } else {
    showToast('✅ Subscribed! Check your inbox.', 'success');
    if (emailEl) emailEl.value = '';
    if (btn)     btn.textContent = 'Subscribed ✓';
  }
}
