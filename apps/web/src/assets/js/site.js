// Shared behaviour for the public pages (index, developers, privacy, terms), loaded with `defer`.
//  1. Header: condenses into a floating pill once the page scrolls
//  2. Mobile navigation drawer
//  3. Letter roll on buttons and header links
//  4. Pointer effects (mouse/trackpad only, never under reduced motion):
//     custom cursor, magnetic secondary buttons, and venom liquid on primary buttons
//  5. Sign-in pop-up
//
// server.ts normally inserts partials/header.html at each page's @header marker. Static
// previews (VS Code Live Server, any plain file server) serve the page as-is, so the marker
// is still a comment: load the partial next to the page instead, and point the site's clean
// URLs (/developers, /#faq, /console) at the actual files.
(() => {
  const marker = findHeaderMarker();
  if (marker) {
    fetch(new URL('partials/header.html', document.baseURI))
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((html) => {
        // Parsed through a <template>, so any script a preview server injects never runs
        const template = document.createElement('template');
        template.innerHTML = html;
        marker.replaceWith(template.content);
      })
      .catch((err) => console.warn('[BriskSMS] Could not load partials/header.html:', err))
      .finally(() => {
        useFileLinks();
        init();
      });
  } else {
    init();
  }

  function findHeaderMarker() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.trim() === '@header') return node;
    }
    return null;
  }

  function useFileLinks() {
    document.querySelectorAll('a[href^="/"]:not([href^="//"])').forEach((a) => {
      const url = new URL(a.getAttribute('href'), location.origin);
      const page = url.pathname === '/' ? 'index' : url.pathname.slice(1);
      a.setAttribute('href', `${page}.html${url.search}${url.hash}`);
    });
  }

  // 5. SIGN-IN POP-UP
  // Signs in against the same API, cookie session and CSRF double-submit as the console, then
  // opens the console. Google sign-in stays in the console, which loads Google's script.
  function setUpSignIn(dialog) {
    const meta = document.querySelector('meta[name="brisksms-api-base"]')?.content?.trim();
    const apiBase = (window.BRISKSMS_API_BASE_URL || meta || (location.port === '4200' ? 'http://localhost:3000' : location.origin)).replace(/\/+$/, '');
    const signinForm = dialog.querySelector('[data-view="signin"]');
    const forgotForm = dialog.querySelector('[data-view="forgot"]');
    const registerForm = dialog.querySelector('[data-view="register"]');
    let consoleUrl = '/console';
    let csrfToken = null;

    function show(name) {
      dialog.querySelectorAll('.signin-view').forEach((view) => {
        view.hidden = view.dataset.view !== name;
      });
      dialog.querySelectorAll('.signin-error').forEach((el) => { el.hidden = true; });
      dialog.querySelector(`[data-view="${name}"]`).querySelector('input, .signin-submit')?.focus();
    }

    function showError(form, message) {
      const el = form.querySelector('.signin-error');
      el.textContent = message;
      el.hidden = false;
    }

    async function ensureCsrf() {
      const cookie = document.cookie.match(/(?:^|;\s*)bsk_csrf=([^;]*)/);
      if (cookie) return decodeURIComponent(cookie[1]);
      if (!csrfToken) {
        const res = await fetch(`${apiBase}/v1/auth/csrf`, { credentials: 'include' });
        csrfToken = (await res.json().catch(() => null))?.data?.csrfToken || null;
      }
      return csrfToken;
    }

    async function post(path, body) {
      const token = await ensureCsrf();
      const res = await fetch(apiBase + path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        const failure = new Error(json?.error?.message || 'Something went wrong. Please try again.');
        failure.code = json?.error?.code;
        throw failure;
      }
      return json?.data;
    }

    // Disables the form while `task` runs and shows any failure inside the form
    async function submit(form, task) {
      const button = form.querySelector('.signin-submit');
      const label = button.textContent;
      button.disabled = true;
      button.textContent = button.dataset.busyLabel;
      form.querySelector('.signin-error').hidden = true;
      try {
        await task();
      } catch (err) {
        showError(form, err instanceof TypeError
          ? "Can't reach BriskSMS right now. Check your connection and try again."
          : err.message);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    }

    // Already signed in: offer the console instead of the form
    async function checkSession() {
      try {
        const res = await fetch(`${apiBase}/v1/auth/session`, { credentials: 'include' });
        const email = res.ok ? (await res.json().catch(() => null))?.data?.user?.email : null;
        const untouched = !signinForm.hidden && !signinForm.elements.email.value && !signinForm.elements.password.value;
        if (email && dialog.open && untouched) {
          dialog.querySelector('[data-session-email]').textContent = email;
          show('session');
        }
      } catch {
        // Offline or API unreachable: the form reports it on submit
      }
    }

    document.addEventListener('click', (e) => {
      const link = e.target instanceof Element ? e.target.closest('[data-signin]') : null;
      if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      consoleUrl = link.getAttribute('href');
      show('signin');
      dialog.showModal();
      checkSession();
    });

    signinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = signinForm.elements.email.value.trim();
      const password = signinForm.elements.password.value;
      if (!email || !password) {
        showError(signinForm, 'Enter your email and password.');
        return;
      }
      submit(signinForm, async () => {
        const totpField = signinForm.querySelector('[data-totp]');
        const totpCode = totpField.hidden ? '' : signinForm.elements.totpCode.value.trim();
        try {
          await post('/v1/auth/login', totpCode ? { email, password, totpCode } : { email, password });
        } catch (err) {
          if (err.code === 'TWO_FACTOR_REQUIRED' || err.code === 'INVALID_TWO_FACTOR_CODE') {
            totpField.hidden = false;
            signinForm.elements.totpCode.focus();
          }
          throw err;
        }
        location.assign(consoleUrl);
      });
    });

    forgotForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = forgotForm.elements.email.value.trim();
      if (!email) {
        showError(forgotForm, 'Enter the email address you use to sign in.');
        return;
      }
      submit(forgotForm, async () => {
        await post('/v1/auth/forgot-password', { email });
        show('sent');
      });
    });

    dialog.querySelectorAll('[data-show-view]').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        if (button.dataset.showView === 'forgot') forgotForm.elements.email.value = signinForm.elements.email.value.trim();
        show(button.dataset.showView);
      });
    });

    dialog.querySelectorAll('.signin-reveal').forEach((reveal) => {
      reveal.addEventListener('click', () => {
        const visible = reveal.getAttribute('aria-pressed') !== 'true';
        reveal.setAttribute('aria-pressed', String(visible));
        reveal.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        reveal.parentElement.querySelector('input').type = visible ? 'text' : 'password';
      });
    });

    // Tells the person right away whether the two passwords match, and only then enables Create account
    const registerHint = registerForm.querySelector('.signin-hint');
    const registerButton = registerForm.querySelector('.signin-submit');
    function checkPasswords() {
      const pw = registerForm.elements.password.value;
      const again = registerForm.elements.confirm.value;
      let text = '';
      let state = '';
      if (pw && pw.length < 8) {
        state = 'bad';
        text = 'Use at least 8 characters';
      } else if (again) {
        state = pw === again ? 'ok' : 'bad';
        text = pw === again ? 'Passwords match' : 'Passwords do not match yet';
      }
      registerHint.textContent = text;
      registerHint.dataset.state = state;
      registerButton.disabled = !(pw.length >= 8 && pw === again);
    }
    registerForm.elements.password.addEventListener('input', checkPasswords);
    registerForm.elements.confirm.addEventListener('input', checkPasswords);

    registerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fullName = registerForm.elements.fullName.value.trim();
      const organizationName = registerForm.elements.organizationName.value.trim();
      const email = registerForm.elements.email.value.trim();
      const password = registerForm.elements.password.value;
      if (!fullName || !email) {
        showError(registerForm, 'Enter your name and email.');
        return;
      }
      if (password.length < 8 || password !== registerForm.elements.confirm.value) {
        showError(registerForm, 'The two passwords must match and be at least 8 characters.');
        return;
      }
      submit(registerForm, async () => {
        await post('/v1/auth/register', { email, password, fullName, organizationName: organizationName || undefined });
        dialog.querySelector('[data-created-email]').textContent = email;
        show('created');
      });
    });

    // Google sign-in is not connected yet (no client id), so the button only says so
    dialog.querySelectorAll('[data-google]').forEach((button) => {
      button.addEventListener('click', () => showError(button.closest('form'), 'Google sign-in is not available yet.'));
    });

    dialog.querySelector('[data-signin-close]').addEventListener('click', () => dialog.close());

    // A click on the dimmed page around the pop-up closes it
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });

    // Never leave a password behind in a closed pop-up
    dialog.addEventListener('close', () => {
      signinForm.elements.password.value = '';
      signinForm.elements.totpCode.value = '';
      signinForm.querySelector('[data-totp]').hidden = true;
      registerForm.reset();
      checkPasswords();
      dialog.querySelectorAll('.signin-reveal[aria-pressed="true"]').forEach((reveal) => reveal.click());
    });
  }

  function init() {
    // 1. HEADER
    const header = document.getElementById('siteHeader');
    if (header) {
      const updateHeader = () => {
        const scrolled = String(window.scrollY > 24);
        if (header.dataset.scrolled !== scrolled) header.dataset.scrolled = scrolled;
      };
      updateHeader();
      addEventListener('scroll', updateHeader, { passive: true });
    }

    // 2. MOBILE NAVIGATION DRAWER
    const menuButton = document.getElementById('mobileMenuBtn');
    const drawer = document.getElementById('mobileNavDrawer');
    if (menuButton && drawer) {
      const setDrawer = (open) => {
        drawer.classList.toggle('open', open);
        drawer.setAttribute('aria-hidden', String(!open));
        menuButton.setAttribute('aria-expanded', String(open));
        document.body.style.overflow = open ? 'hidden' : '';
      };
      menuButton.addEventListener('click', () => setDrawer(true));
      document.getElementById('mobileNavClose')?.addEventListener('click', () => setDrawer(false));
      document.getElementById('mobileNavBackdrop')?.addEventListener('click', () => setDrawer(false));
      drawer.querySelectorAll('.mobile-nav-item').forEach((item) => item.addEventListener('click', () => setDrawer(false)));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && drawer.classList.contains('open')) setDrawer(false);
      });
    }

    // 3. LETTER ROLL: letters roll up to an identical copy on hover; screen readers get the plain label
    function addTextRoll(el) {
      const textNode = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      if (!textNode) return;
      const text = textNode.textContent.trim();
      const roll = document.createElement('span');
      roll.className = 'text-roll';
      const label = document.createElement('span');
      label.className = 'text-roll-label';
      label.textContent = text;
      const letters = document.createElement('span');
      letters.className = 'text-roll-in';
      letters.setAttribute('aria-hidden', 'true');
      Array.from(text).forEach((ch, i) => {
        const letter = document.createElement('span');
        letter.textContent = ch;
        letter.style.setProperty('--i', i);
        letters.appendChild(letter);
      });
      roll.append(label, letters);
      textNode.replaceWith(roll);
    }
    document.querySelectorAll('.btn, .site-nav-link, .site-signin').forEach(addTextRoll);

    const signinDialog = document.getElementById('signinDialog');
    if (signinDialog && typeof signinDialog.showModal === 'function') setUpSignIn(signinDialog);

    // 4. POINTER EFFECTS
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const HOT = 'a, button, [role="button"], label, select, summary';
    const TEXT = 'input, textarea, [contenteditable="true"], pre, code';
    const MAGNETS = '.hero-actions .btn:not(.venom-link), .final-cta-actions .btn:not(.venom-link)';
    const MAGNET_REACH = 80;  // px beyond a button's edge where the pull begins
    const MAGNET_PULL = 0.3;  // share of the pointer's offset from centre that the button follows
    const MAGNET_MAX = 12;    // px
    const VENOM_REACH = 110;  // px beyond the pill's edge where the liquid starts to rise
    const VENOM_MAX = 64;     // px the tendril can stretch (the goo layer has 72px of room)
    const VENOM_ROOM = 72;    // must match .venom-goo { inset: -72px }
    const BEADS = [30, 24, 19, 15, 12]; // droplet diameters from the pill surface to the tip

    // Cursor: an exact dot plus a ring that trails it
    const dot = document.createElement('div');
    const ring = document.createElement('div');
    dot.className = 'cursor-dot';
    ring.className = 'cursor-ring';
    dot.setAttribute('aria-hidden', 'true');
    ring.setAttribute('aria-hidden', 'true');
    document.body.append(ring, dot);
    document.documentElement.classList.add('cursor-on');

    // Magnetic buttons move via `translate` so their own hover transforms still apply; their
    // existing transitions are kept, but `translate` must follow the spring directly.
    const magnets = Array.from(document.querySelectorAll(MAGNETS), (el) => {
      const s = getComputedStyle(el);
      el.style.transitionProperty = `${s.transitionProperty}, translate`;
      el.style.transitionDuration = `${s.transitionDuration}, 0s`;
      el.style.transitionTimingFunction = `${s.transitionTimingFunction}, linear`;
      el.style.transitionDelay = `${s.transitionDelay}, 0s`;
      return { el, x: 0, y: 0, vx: 0, vy: 0 };
    });

    // Venom: a gooey SVG filter melts the pill and a chain of droplets into one liquid shape
    const venomHosts = Array.from(document.querySelectorAll('.venom-host'));
    if (venomHosts.length) {
      document.body.insertAdjacentHTML('beforeend',
        '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">' +
        '<filter id="venom-goo" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
        '<feGaussianBlur in="SourceGraphic" stdDeviation="7"/>' +
        '<feColorMatrix mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"/>' +
        '</filter></svg>');
    }
    const venoms = venomHosts.map((host) => {
      const goo = document.createElement('span');
      goo.className = 'venom-goo';
      goo.setAttribute('aria-hidden', 'true');
      const pill = document.createElement('span');
      pill.className = 'venom-pill';
      goo.append(pill);
      const beads = BEADS.map((size) => {
        const el = document.createElement('span');
        el.className = 'venom-bead';
        goo.append(el);
        return { el, size, x: 0, y: 0, s: 0, vx: 0, vy: 0, vs: 0 };
      });
      host.prepend(goo);
      host.dataset.venom = 'live';
      return { host, beads, ax: 0, ay: 0 };
    });

    const smooth = (t) => t * t * (3 - 2 * t);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let px = 0, py = 0, rx = 0, ry = 0;
    let present = false, running = false;

    function stepMagnets() {
      let moving = false;
      const rects = magnets.map((m) => m.el.getBoundingClientRect());
      magnets.forEach((m, i) => {
        const r = rects[i];
        // Offset from the button's resting centre (the rect includes the current shift)
        const dx = px - (r.left + r.width / 2 - m.x);
        const dy = py - (r.top + r.height / 2 - m.y);
        const edge = Math.hypot(Math.max(0, Math.abs(dx) - r.width / 2), Math.max(0, Math.abs(dy) - r.height / 2));
        const near = present && r.width > 0 ? Math.max(0, 1 - edge / MAGNET_REACH) : 0;
        const tx = clamp(dx * MAGNET_PULL * smooth(near), -MAGNET_MAX, MAGNET_MAX);
        const ty = clamp(dy * MAGNET_PULL * smooth(near), -MAGNET_MAX, MAGNET_MAX);
        // Under-damped spring: a slight overshoot when the button snaps back
        m.vx = (m.vx + (tx - m.x) * 0.16) * 0.74;
        m.vy = (m.vy + (ty - m.y) * 0.16) * 0.74;
        m.x += m.vx;
        m.y += m.vy;
        m.el.style.translate = `${m.x.toFixed(2)}px ${m.y.toFixed(2)}px`;
        if (Math.abs(tx - m.x) + Math.abs(ty - m.y) + Math.abs(m.vx) + Math.abs(m.vy) > 0.05) moving = true;
      });
      return moving;
    }

    function stepVenoms() {
      let moving = false;
      venoms.forEach((v) => {
        const r = v.host.getBoundingClientRect();
        const radius = r.height / 2;
        // Nearest point on the pill outline: project onto the pill's centre line, then out by the radius
        const lx = px - r.left;
        const ly = py - r.top;
        const cx = clamp(lx, radius, Math.max(radius, r.width - radius));
        const cy = radius;
        const dist = Math.hypot(lx - cx, ly - cy) || 1;
        const nx = (lx - cx) / dist;
        const ny = (ly - cy) / dist;
        const edge = dist - radius;
        const near = present && r.width > 0 && edge > 0 ? Math.max(0, 1 - edge / VENOM_REACH) : 0;
        const strength = smooth(near);
        // While the pointer is near, the tendril roots where it points; when it lets go, the
        // droplets fall back to where they rose from
        if (strength > 0) {
          v.ax = cx + nx * radius * 0.82;
          v.ay = cy + ny * radius * 0.82;
        }
        const length = Math.min(edge * strength, VENOM_MAX);

        v.beads.forEach((b, i) => {
          const t = (i + 0.35) / v.beads.length;
          const tx = VENOM_ROOM + v.ax + nx * length * t;
          const ty = VENOM_ROOM + v.ay + ny * length * t;
          const ts = strength > 0.02 ? (b.size / 32) * (0.35 + 0.65 * strength) : 0;
          // An invisible droplet waits at the root, so it always grows out of the pill surface
          if (b.s < 0.01) {
            b.x = VENOM_ROOM + v.ax;
            b.y = VENOM_ROOM + v.ay;
            b.vx = 0;
            b.vy = 0;
          }
          // Droplets nearer the tip are looser, so the strand stretches and wobbles
          const k = 0.22 - i * 0.03;
          b.vx = (b.vx + (tx - b.x) * k) * 0.72;
          b.vy = (b.vy + (ty - b.y) * k) * 0.72;
          b.vs = (b.vs + (ts - b.s) * 0.18) * 0.7;
          b.x += b.vx;
          b.y += b.vy;
          b.s = Math.max(0, b.s + b.vs);
          b.el.style.transform = `translate(${(b.x - 16).toFixed(2)}px, ${(b.y - 16).toFixed(2)}px) scale(${b.s.toFixed(3)})`;
          if (Math.abs(tx - b.x) + Math.abs(ty - b.y) + Math.abs(ts - b.s) * 40 + Math.abs(b.vx) + Math.abs(b.vy) > 0.05) moving = true;
        });
      });
      return moving;
    }

    function tick() {
      rx += (px - rx) * 0.2;
      ry += (py - ry) * 0.2;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      const ringMoving = Math.abs(px - rx) + Math.abs(py - ry) > 0.1;
      const magnetsMoving = stepMagnets();
      const venomsMoving = stepVenoms();
      running = ringMoving || magnetsMoving || venomsMoving;
      if (running) requestAnimationFrame(tick);
    }

    function start() {
      if (running) return;
      running = true;
      requestAnimationFrame(tick);
    }

    addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      px = e.clientX;
      py = e.clientY;
      if (!present) {
        rx = px;
        ry = py;
        present = true;
      }
      dot.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      const target = e.target instanceof Element ? e.target : null;
      const state = target && target.closest(TEXT) ? 'text' : target && target.closest(HOT) ? 'hot' : '';
      dot.dataset.state = state;
      ring.dataset.state = state;
      dot.classList.add('is-visible');
      ring.classList.add('is-visible');
      start();
    }, { passive: true });

    // Buttons scroll under a still pointer, so re-check on scroll
    addEventListener('scroll', start, { passive: true });

    document.documentElement.addEventListener('mouseleave', () => {
      present = false;
      dot.classList.remove('is-visible');
      ring.classList.remove('is-visible');
      start();
    });

    addEventListener('pointerdown', () => ring.classList.add('is-down'));
    addEventListener('pointerup', () => ring.classList.remove('is-down'));
  }
})();
