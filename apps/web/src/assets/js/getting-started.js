/*
 * Setup guide (getting-started.html): scroll reveals, the on-page link that marks the section being
 * read, and pausing the hero illustration while it is off-screen. Without this file the page is fully
 * readable; with prefers-reduced-motion nothing is hidden or animated.
 */
(function () {
  'use strict';

  // Tells the page's safety timer that this script is running, so nothing stays hidden
  document.documentElement.classList.add('gs-ready');

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasObserver = 'IntersectionObserver' in window;

  // Reveals: items rise in as they enter the viewport, staggered within their group
  var groups = [
    '.gs-needs',
    '.gs-steps',
    '.gs-flow',
    '.gs-trouble',
    '.gs-faq'
  ];
  var targets = [];

  document.querySelectorAll('.gs-section h2, .gs-note, .gs-cta .container').forEach(function (el) {
    targets.push(el);
  });
  groups.forEach(function (selector) {
    var group = document.querySelector(selector);
    if (!group) return;
    Array.prototype.forEach.call(group.children, function (child, index) {
      child.style.setProperty('--i', String(Math.min(index, 4)));
      targets.push(child);
    });
  });

  if (reduce || !hasObserver) {
    targets.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var reveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          reveal.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    targets.forEach(function (el) { reveal.observe(el); });
  }

  // The hero illustration only runs while it can be seen
  var art = document.querySelector('.gs-art');
  if (art && hasObserver && !reduce) {
    new IntersectionObserver(function (entries) {
      art.classList.toggle('is-paused', !entries[0].isIntersecting);
    }).observe(art);
  }

  // Scroll-linked motion: reading progress, the hero easing away, and the step lines filling as you pass them
  if (!reduce) {
    var root = document.documentElement;
    var bar = document.createElement('div');
    bar.className = 'gs-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    var heroEl = document.querySelector('.gs-hero');
    var stepEls = Array.prototype.slice.call(document.querySelectorAll('.gs-steps > li'));
    var queued = false;

    var clamp = function (n) { return Math.min(1, Math.max(0, n)); };

    var update = function () {
      queued = false;
      var vh = window.innerHeight;
      var max = root.scrollHeight - vh;
      root.style.setProperty('--gs-progress', (max > 0 ? clamp(window.scrollY / max) : 0).toFixed(4));
      if (heroEl) {
        root.style.setProperty('--gs-hero', clamp(window.scrollY / heroEl.offsetHeight).toFixed(3));
      }
      var mark = vh * 0.6;
      stepEls.forEach(function (li) {
        var box = li.getBoundingClientRect();
        li.style.setProperty('--fill', clamp((mark - box.top) / box.height).toFixed(3));
        li.classList.toggle('is-current', box.top < mark && box.bottom > mark);
      });
    };

    var queue = function () {
      if (!queued) {
        queued = true;
        window.requestAnimationFrame(update);
      }
    };

    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    update();
  }

  // On-page links: mark the section being read
  var links = Array.prototype.slice.call(document.querySelectorAll('.gs-jump a'));
  if (links.length && hasObserver && !reduce) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('is-active'); });
        var link = byId[entry.target.id];
        if (link) link.classList.add('is-active');
      });
    }, { rootMargin: '-35% 0px -55% 0px' });
    Object.keys(byId).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) spy.observe(section);
    });
    // Back at the top, no section is being read
    var hero = document.querySelector('.gs-hero');
    if (hero) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && entries[0].intersectionRatio > 0.6) {
          links.forEach(function (a) { a.classList.remove('is-active'); });
        }
      }, { threshold: [0, 0.6, 1] }).observe(hero);
    }
  }
}());
