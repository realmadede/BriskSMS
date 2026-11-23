// 1. Dynamic Hero Variations
const heroData = [
  {
    headline: "Every payment deserves clarity.",
    accent: "clarity",
    description: "Bring payment messages, transaction records, and invoice reconciliation into one organized workspace. Spend less time checking payments and more time running your business."
  },
  {
    headline: "Stop chasing payments. Start seeing the full picture.",
    accent: "picture",
    description: "Know which payments have been received, which invoices remain outstanding, and which transactions need your attention."
  },
  {
    headline: "Your business moves. Your payment records should keep up.",
    accent: "moves",
    description: "Turn incoming payment messages into organized transaction records. Match payments to invoices, identify exceptions, and keep your financial operations moving."
  },
  {
    headline: "Better business communication starts here.",
    accent: "communication",
    description: "Reach customers with single, bulk, and scheduled SMS campaigns. Manage your messaging alongside the tools that help you run your business."
  }
];

const headlineEl = document.getElementById('heroHeadline');
const descEl = document.getElementById('heroDescription');
const heroStageEl = document.querySelector('.hero-stage');

function switchHero(index) {
  if (!headlineEl || !descEl) return;

  // Smooth fade-out and slight downward reset
  headlineEl.classList.remove('revealed');
  headlineEl.style.opacity = '0';
  headlineEl.style.transform = 'translateY(6px)';
  descEl.style.opacity = '0';
  descEl.style.transform = 'translateY(6px)';

  setTimeout(() => {
    // Build progressive kinetic words with staggered reveal
    const { headline, accent } = heroData[index];
    headlineEl.innerHTML = headline.split(' ').map((w, idx) => {
      const word = w.replace(/[.,]$/, '') === accent
        ? `<span class="hero-mark">${accent}</span>${w.slice(accent.length)}`
        : w;
      return `<span class="kinetic-word" style="transition-delay: ${idx * 45}ms;">${word}</span>`;
    }).join(' ');

    descEl.textContent = heroData[index].description;

    // Force browser layout reflow to trigger sequential reveal transitions
    void headlineEl.offsetHeight;

    headlineEl.classList.add('revealed');
    headlineEl.style.opacity = '1';
    headlineEl.style.transform = 'translateY(0)';
    descEl.style.opacity = '1';
    descEl.style.transform = 'translateY(0)';
  }, 200);
}

let currentHeroIndex = 0;
let autoCycle = null;

function startHeroCycle() {
  if (autoCycle) clearInterval(autoCycle);
  autoCycle = setInterval(() => {
    currentHeroIndex = (currentHeroIndex + 1) % heroData.length;
    switchHero(currentHeroIndex);
  }, 5000);
}

function stopHeroCycle() {
  if (autoCycle) {
    clearInterval(autoCycle);
    autoCycle = null;
  }
}

// Start auto-rotation
startHeroCycle();

// Pause on hover so users can finish reading comfortably
if (heroStageEl) {
  heroStageEl.addEventListener('mouseenter', stopHeroCycle);
  heroStageEl.addEventListener('mouseleave', startHeroCycle);
}

// Pause when tab is hidden, resume when visible
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopHeroCycle();
  } else {
    startHeroCycle();
  }
});



// 2. Scroll-Driven Storytelling (Intersection Observer for Kinetic Typography)
const kineticElements = document.querySelectorAll('.kinetic-text');
const kineticObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
    }
  });
}, { threshold: 0.25 });

kineticElements.forEach(el => kineticObserver.observe(el));


// Scroll-Driven Building Animation Observer
const buildElements = document.querySelectorAll('.scroll-build');
const buildObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('built');
    }
  });
}, { threshold: 0.18 });

buildElements.forEach(el => buildObserver.observe(el));

// 3. Responsive 3D Chrome Spheres Motion Engine
const s1 = document.getElementById('sphere1');
const s1Shadow = document.getElementById('sphereShadow1');
const s2 = document.getElementById('sphere2');
const s3 = document.getElementById('sphere3');
const heroCard = document.getElementById('heroCard');

let mouseX = 0, mouseY = 0;
let currentX1 = 0, currentY1 = 0;
let currentX2 = 0, currentY2 = 0;
let currentX3 = 0, currentY3 = 0;
const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!isReducedMotion) {
  window.addEventListener('mousemove', (e) => {
    const rect = heroCard.getBoundingClientRect();
    if (e.clientY < rect.bottom + 200) {
      mouseX = (e.clientX - window.innerWidth / 2);
      mouseY = (e.clientY - window.innerHeight / 2);
    }
  });

  function animateSpheres(time) {
    // Grounded Landing Physics: Sphere 1 rests solidly on its contact plane
    const float1 = Math.sin(time * 0.001) * 1.5; /* Micro-breathing of 1.5px, firmly grounded */
    const rot1 = Math.sin(time * 0.0005) * 2;

    const float2 = Math.cos(time * 0.0014) * 5;
    const float3 = Math.sin(time * 0.0009) * 10;

    // Smooth Mouse Parallax Easing
    currentX1 += (mouseX * 0.02 - currentX1) * 0.05;
    currentY1 += (mouseY * 0.02 - currentY1) * 0.05;

    currentX2 += (mouseX * -0.035 - currentX2) * 0.05;
    currentY2 += (mouseY * -0.035 - currentY2) * 0.05;

    currentX3 += (mouseX * 0.05 - currentX3) * 0.05;
    currentY3 += (mouseY * 0.05 - currentY3) * 0.05;

    // Scroll Parallax
    const scrollY = window.scrollY;
    const scrollOffset1 = scrollY * 0.06;
    const scrollOffset2 = scrollY * 0.12;
    const scrollOffset3 = scrollY * -0.15;

    if (s1) s1.style.transform = `translate3d(${currentX1}px, ${float1 + currentY1 - scrollOffset1}px, 0) rotate(${rot1}deg)`;
    if (s1Shadow) s1Shadow.style.transform = `translate3d(${currentX1 * 0.7}px, ${currentY1 * 0.15}px, 0) scale(${1 + float1 * 0.008})`;
    if (s2) s2.style.transform = `translate3d(${currentX2}px, ${float2 + currentY2 - scrollOffset2}px, 0)`;
    if (s3) s3.style.transform = `translate3d(${currentX3}px, ${float3 + currentY3 - scrollOffset3}px, 0)`;

    // Scroll-Dynamic Chrome Atmosphere Across Entire Website
    const atmoSpheres = document.querySelectorAll(".atmospheric-sphere");
    atmoSpheres.forEach((atmo, i) => {
      const speed = parseFloat(atmo.dataset.speed || 0.1);
      const rect = atmo.getBoundingClientRect();
      if (rect.top < window.innerHeight + 350 && rect.bottom > -350) {
        const relScroll = (window.innerHeight / 2 - rect.top) * speed;
        const atmoFloat = Math.sin(time * 0.0011 + i) * 7;
        const atmoRot = Math.sin(time * 0.0006 + i) * 3 + (scrollY * 0.02 * (i % 2 === 0 ? 1 : -1));
        atmo.style.transform = `translate3d(${currentX1 * 0.3 * (i % 2 === 0 ? 1 : -1)}px, ${atmoFloat + relScroll}px, 0) rotate(${atmoRot}deg)`;
      }
    });

    requestAnimationFrame(animateSpheres);
  }

  requestAnimationFrame(animateSpheres);
}

// 4. FAQ Accordion Interaction
const faqItems = document.querySelectorAll('.faq-item');
faqItems.forEach(item => {
  const questionBtn = item.querySelector('.faq-question');
  questionBtn.addEventListener('click', () => {
    const wasActive = item.classList.contains('active');
    faqItems.forEach(otherItem => otherItem.classList.remove('active'));
    if (!wasActive) {
      item.classList.add('active');
    }
  });
});

// 6. Ambient Layers: code rain columns, and drift/rain only animate while on screen
const rainEl = document.querySelector('.code-rain');
if (rainEl && !isReducedMotion) {
  const tokens = ['TZS', 'REF', 'POST', '200', 'OK', 'SMS', 'INV', 'HMAC'];
  const glyphs = '0123456789ABCDEF';
  const columnCount = Math.max(12, Math.round(rainEl.clientWidth / 26));
  for (let i = 0; i < columnCount; i++) {
    let run = '';
    while (run.length < 48) {
      run += Math.random() < 0.18
        ? tokens[Math.floor(Math.random() * tokens.length)]
        : glyphs[Math.floor(Math.random() * glyphs.length)];
    }
    const col = document.createElement('span');
    col.className = i % 3 === 2 ? 'code-rain-col is-dim' : 'code-rain-col';
    col.dataset.c = run;
    col.style.left = `${(i / columnCount) * 100}%`;
    col.style.animationDuration = `${(5 + Math.random() * 6).toFixed(2)}s`;
    col.style.animationDelay = `${(-Math.random() * 11).toFixed(2)}s`;
    rainEl.appendChild(col);
  }
}

const ambientObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => entry.target.classList.toggle('is-running', entry.isIntersecting));
});
document.querySelectorAll('.drift, .code-rain').forEach(el => ambientObserver.observe(el));


// Hero illustration: pause its loop (CSS and SMIL) while the hero is off-screen
const heroArt = document.getElementById('heroArt');
if (heroArt && heroCard && 'IntersectionObserver' in window) {
  const artSvg = heroArt.querySelector('svg');
  new IntersectionObserver(([entry]) => {
    heroArt.classList.toggle('is-offscreen', !entry.isIntersecting);
    if (artSvg.pauseAnimations) {
      if (entry.isIntersecting) artSvg.unpauseAnimations();
      else artSvg.pauseAnimations();
    }
  }).observe(heroCard);
}


// Payment journey: the rail fills as the reader scrolls down the stages
const journeyTimeline = document.querySelector('.journey-timeline');
if (journeyTimeline && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let ticking = false;
  let active = false;
  const updateRail = () => {
    ticking = false;
    const r = journeyTimeline.getBoundingClientRect();
    const p = (window.innerHeight * 0.6 - r.top) / r.height;
    journeyTimeline.style.setProperty('--journey-progress', Math.min(1, Math.max(0, p)).toFixed(3));
  };
  const onScroll = () => {
    if (!ticking) { ticking = true; requestAnimationFrame(updateRail); }
  };
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !active) { active = true; window.addEventListener('scroll', onScroll, { passive: true }); }
    if (!entry.isIntersecting && active) { active = false; window.removeEventListener('scroll', onScroll); }
    updateRail();
  }, { rootMargin: '200px 0px' }).observe(journeyTimeline);
  updateRail();
}
