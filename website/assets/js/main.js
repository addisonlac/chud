/* =========================================================================
   Contentric — interaction layer
   Vanilla JS, no dependencies. Everything degrades gracefully: without JS
   the page is still fully readable, and every motion effect is disabled
   under prefers-reduced-motion.
   ========================================================================= */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coarse = window.matchMedia("(pointer: coarse)").matches;

  var clamp = function (v, min, max) { return v < min ? min : v > max ? max : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  /* ===================================================== momentum scrolling
     A lightweight inertial scroller. It animates the *real* document scroll
     position (rather than transforming a wrapper) so `position: sticky`,
     anchor links and the native scrollbar all keep working.
     ---------------------------------------------------------------------- */
  var scroller = {
    target: window.scrollY,
    current: window.scrollY,
    ease: 0.105,
    enabled: !reduced && !coarse,
    animating: false
  };

  function maxScroll() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  if (scroller.enabled) {
    root.classList.add("js-smooth");

    window.addEventListener("wheel", function (e) {
      if (e.ctrlKey) return;                 // pinch-zoom
      if (scroller.animating) return;        // an anchor tween owns the scroll
      // let elements with their own scrollbar (a long textarea, a select)
      // consume the wheel themselves
      if (e.target && e.target.closest && e.target.closest("textarea, select")) return;
      e.preventDefault();
      var delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 18;    // lines
      else if (e.deltaMode === 2) delta *= window.innerHeight;
      scroller.target = clamp(scroller.target + delta, 0, maxScroll());
    }, { passive: false });

    // Anything that moves the page outside our control (scrollbar drag,
    // keyboard, find-in-page) resyncs the virtual position.
    window.addEventListener("scroll", function () {
      if (scroller.animating) return;
      if (Math.abs(window.scrollY - scroller.current) > 4) {
        scroller.current = scroller.target = window.scrollY;
      }
    }, { passive: true });

    window.addEventListener("resize", function () {
      scroller.target = clamp(scroller.target, 0, maxScroll());
    });
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function scrollToY(to, duration) {
    to = clamp(to, 0, maxScroll());
    if (reduced) {
      window.scrollTo(0, to);
      scroller.current = scroller.target = to;
      return;
    }
    var from = window.scrollY;
    var dist = to - from;
    if (Math.abs(dist) < 1) return;
    var start = performance.now();
    duration = duration || clamp(Math.abs(dist) * 0.55, 480, 1150);
    scroller.animating = true;

    (function step(now) {
      var t = clamp((now - start) / duration, 0, 1);
      var y = from + dist * easeInOutCubic(t);
      window.scrollTo(0, y);
      scroller.current = scroller.target = y;
      if (t < 1) requestAnimationFrame(step);
      else scroller.animating = false;
    })(start);
  }

  /* ------------------------------------------------------- anchor links */
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      if (!id || id === "#") return;
      var el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      closeMobileMenu();
      var offset = id === "#top" ? 0 : el.getBoundingClientRect().top + window.scrollY - 88;
      scrollToY(offset);
      history.replaceState(null, "", id);
    });
  });

  /* =============================================================== header */
  var header = $("[data-header]");
  var progressBar = $("[data-progress]");
  var lastY = window.scrollY;

  function updateHeader(y) {
    if (!header) return;
    header.classList.toggle("is-stuck", y > 12);
    var goingDown = y > lastY && y > 420;
    header.classList.toggle("is-hidden", goingDown && !mobileOpen);
    lastY = y;
  }

  function updateProgress(y) {
    if (!progressBar) return;
    var max = maxScroll();
    progressBar.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
  }

  /* ------------------------------------------------------ active nav link */
  var navLinks = $$(".nav a[href^='#']");
  var sections = navLinks
    .map(function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);

  function updateActiveNav(y) {
    if (!sections.length) return;
    var probe = y + window.innerHeight * 0.34;
    var activeIndex = -1;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= probe) activeIndex = i;
    }
    navLinks.forEach(function (a, i) { a.classList.toggle("is-current", i === activeIndex); });
  }

  /* ========================================================= mobile menu */
  var burger = $("[data-burger]");
  var mobileMenu = $("[data-mobile-menu]");
  var mobileOpen = false;

  function openMobileMenu() {
    if (!mobileMenu || !burger) return;
    mobileOpen = true;
    mobileMenu.hidden = false;
    requestAnimationFrame(function () { mobileMenu.classList.add("is-open"); });
    burger.setAttribute("aria-expanded", "true");
    burger.setAttribute("aria-label", "Close menu");
    document.body.style.overflow = "hidden";
  }

  function closeMobileMenu() {
    if (!mobileMenu || !burger || !mobileOpen) return;
    mobileOpen = false;
    mobileMenu.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
    burger.setAttribute("aria-label", "Open menu");
    document.body.style.overflow = "";
    window.setTimeout(function () { if (!mobileOpen) mobileMenu.hidden = true; }, 350);
  }

  if (burger) {
    burger.addEventListener("click", function () {
      mobileOpen ? closeMobileMenu() : openMobileMenu();
    });
  }
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeMobileMenu();
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 1080) closeMobileMenu();
  });

  /* ================================================== reveal on scroll */
  var revealables = $$("[data-reveal]");
  revealables.forEach(function (el) {
    var d = el.getAttribute("data-reveal-delay");
    if (d) el.style.setProperty("--d", d);
  });

  if ("IntersectionObserver" in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // A jump (deep link, scrollIntoView, a fast flick) can carry an element
        // clean past the viewport without it ever reading as intersecting, so
        // anything now above the fold is settled too.
        var passed = entry.boundingClientRect.bottom < 0;
        if (entry.isIntersecting || passed) {
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
    revealables.forEach(function (el) { revealObserver.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ====================================================== number counters */
  function formatNumber(value, el) {
    var decimals = parseInt(el.getAttribute("data-count-decimals") || "0", 10);
    var out = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
    if (el.getAttribute("data-count-format") === "comma") {
      var parts = out.split(".");
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      out = parts.join(".");
    }
    return out + (el.getAttribute("data-count-suffix") || "");
  }

  function runCounter(el) {
    var to = parseFloat(el.getAttribute("data-count"));
    if (isNaN(to)) return;
    el.setAttribute("data-counted", "1");
    if (reduced) { el.textContent = formatNumber(to, el); return; }
    var duration = 1700;
    var start = performance.now();
    (function tick(now) {
      var t = clamp((now - start) / duration, 0, 1);
      var eased = 1 - Math.pow(1 - t, 4);        // easeOutQuart
      el.textContent = formatNumber(to * eased, el);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = formatNumber(to, el);
    })(start);
  }

  var counters = $$("[data-count]");
  if (counters.length && "IntersectionObserver" in window) {
    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var el = entry.target;
        if (entry.isIntersecting) {
          runCounter(el);
          countObserver.unobserve(el);
        } else if (entry.boundingClientRect.bottom < 0) {
          // scrolled past without ever animating — show the real figure
          var to = parseFloat(el.getAttribute("data-count"));
          if (!isNaN(to)) el.textContent = formatNumber(to, el);
          countObserver.unobserve(el);
        }
      });
    }, { threshold: 0.6 });
    counters.forEach(function (el) { countObserver.observe(el); });
  } else {
    counters.forEach(runCounter);
  }

  /* ---------------------------------------------------------- safety net
     IntersectionObserver only reports *threshold crossings*. An element that
     travels from below the fold to above it in a single jump — a deep link,
     scrollIntoView, a hard flick — crosses no threshold, so no callback ever
     fires and it would sit at its placeholder value forever. This sweep runs
     occasionally from the master loop and settles anything left behind. Both
     lists drain to empty as the page is read, so it costs nothing after that.
     -------------------------------------------------------------------- */
  var pendingReveals = revealables.slice();
  var pendingCounters = counters.slice();

  function settlePassed() {
    if (pendingReveals.length) {
      pendingReveals = pendingReveals.filter(function (el) {
        if (el.classList.contains("is-in")) return false;
        if (el.getBoundingClientRect().bottom < 0) {
          el.classList.add("is-in");
          return false;
        }
        return true;
      });
    }
    if (pendingCounters.length) {
      pendingCounters = pendingCounters.filter(function (el) {
        if (el.getAttribute("data-counted")) return false;
        if (el.getBoundingClientRect().bottom < 0) {
          var to = parseFloat(el.getAttribute("data-count"));
          if (!isNaN(to)) el.textContent = formatNumber(to, el);
          el.setAttribute("data-counted", "1");
          return false;
        }
        return true;
      });
    }
  }

  /* ================================================== spotlight + tilt */
  $$("[data-spotlight]").forEach(function (card) {
    card.addEventListener("pointermove", function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
      card.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
    });
  });

  if (!reduced && !coarse) {
    $$("[data-tilt]").forEach(function (el) {
      var strength = parseFloat(el.getAttribute("data-tilt-strength") || "6");
      var raf = null;
      var rx = 0, ry = 0;

      function apply() {
        el.style.transform = "perspective(1200px) rotateX(" + rx + "deg) rotateY(" + ry + "deg)";
        raf = null;
      }
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        ry = ((e.clientX - r.left) / r.width - 0.5) * strength;
        rx = -((e.clientY - r.top) / r.height - 0.5) * strength;
        if (!raf) raf = requestAnimationFrame(apply);
      });
      el.addEventListener("pointerleave", function () {
        rx = ry = 0;
        if (!raf) raf = requestAnimationFrame(apply);
      });
    });
  }

  /* ========================================================= custom cursor */
  var cursor = $("[data-cursor]");
  var cursorState = { x: window.innerWidth / 2, y: window.innerHeight / 2, tx: 0, ty: 0, dx: 0, dy: 0 };

  if (cursor && !reduced && !coarse) {
    var dot = $(".cursor__dot", cursor);
    var ring = $(".cursor__ring", cursor);
    cursorState.tx = cursorState.x;
    cursorState.ty = cursorState.y;

    window.addEventListener("pointermove", function (e) {
      cursorState.tx = e.clientX;
      cursorState.ty = e.clientY;
      cursor.classList.add("is-on");
    }, { passive: true });

    document.addEventListener("pointerleave", function () { cursor.classList.remove("is-on"); });

    var hotSelector = "a, button, [data-tilt], input, select, textarea, .faq__q";
    document.addEventListener("pointerover", function (e) {
      if (e.target.closest && e.target.closest(hotSelector)) cursor.classList.add("is-hot");
    });
    document.addEventListener("pointerout", function (e) {
      if (e.target.closest && e.target.closest(hotSelector)) cursor.classList.remove("is-hot");
    });

    cursor._render = function () {
      cursorState.x = lerp(cursorState.x, cursorState.tx, 0.9);
      cursorState.y = lerp(cursorState.y, cursorState.ty, 0.9);
      cursorState.dx = lerp(cursorState.dx, cursorState.tx, 0.18);
      cursorState.dy = lerp(cursorState.dy, cursorState.ty, 0.18);
      dot.style.transform = "translate3d(" + cursorState.x + "px," + cursorState.y + "px,0) translate(-50%,-50%)";
      ring.style.transform = "translate3d(" + cursorState.dx + "px," + cursorState.dy + "px,0) translate(-50%,-50%)";
    };
  }

  /* ============================================= engine (pinned sequence) */
  var engine = $("[data-engine]");
  var engineSteps = $$("[data-engine-step]");
  var enginePanels = $$("[data-engine-panel]");
  var engineRail = $("[data-engine-rail]");
  var engineIndex = -1;

  function updateEngine() {
    if (!engine || !engineSteps.length) return;
    var probe = window.innerHeight * 0.52;
    var next = 0;
    engineSteps.forEach(function (step, i) {
      if (step.getBoundingClientRect().top <= probe) next = i;
    });
    if (next === engineIndex) return;
    engineIndex = next;
    engineSteps.forEach(function (s, i) { s.classList.toggle("is-active", i === next); });
    enginePanels.forEach(function (p, i) { p.classList.toggle("is-active", i === next); });
    if (engineRail) {
      engineRail.style.height = (100 / engineSteps.length) + "%";
      engineRail.style.transform = "translateY(" + next * 100 + "%)";
    }
  }

  /* ========================================================= FAQ accordion */
  $$("[data-accordion] .faq__item").forEach(function (item) {
    var btn = $(".faq__q", item);
    if (!btn) return;
    btn.addEventListener("click", function () {
      var isOpen = item.classList.contains("is-open");
      // one panel at a time keeps the column from jumping around
      $$("[data-accordion] .faq__item").forEach(function (other) {
        other.classList.remove("is-open");
        var b = $(".faq__q", other);
        if (b) b.setAttribute("aria-expanded", "false");
      });
      if (!isOpen) {
        item.classList.add("is-open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ========================================================= billing toggle */
  var billing = $("[data-billing]");
  if (billing) {
    var options = $$("[data-billing-option]", billing);
    var thumb = $(".toggle__thumb", billing);
    var prices = $$("[data-price]");

    function moveThumb(btn) {
      if (!thumb) return;
      thumb.style.width = btn.offsetWidth + "px";
      thumb.style.transform = "translateX(" + (btn.offsetLeft - 4) + "px)";
    }

    options.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.getAttribute("data-billing-option");
        options.forEach(function (o) {
          var on = o === btn;
          o.classList.toggle("is-active", on);
          o.setAttribute("aria-pressed", on ? "true" : "false");
        });
        moveThumb(btn);
        prices.forEach(function (p) {
          var value = p.getAttribute("data-" + mode);
          if (!value) return;
          p.style.opacity = "0";
          p.style.transform = "translateY(-4px)";
          window.setTimeout(function () {
            p.textContent = value;
            p.style.transition = "opacity .3s, transform .3s";
            p.style.opacity = "1";
            p.style.transform = "none";
          }, 140);
        });
      });
    });

    prices.forEach(function (p) { p.style.transition = "opacity .3s, transform .3s"; });
    var initial = $(".is-active", billing) || options[0];
    if (initial) {
      requestAnimationFrame(function () { moveThumb(initial); });
      window.addEventListener("resize", function () {
        var active = $(".is-active", billing);
        if (active) moveThumb(active);
      });
    }
  }

  /* ================================================================= form */
  var form = $("[data-form]");
  if (form) {
    var note = $("[data-form-note]", form);
    var defaultNote = note ? note.textContent : "";

    function fieldOf(input) { return input.closest(".field"); }

    function validate(input) {
      var field = fieldOf(input);
      if (!field) return true;
      var error = $("[data-error]", field);
      var value = input.value.trim();
      var message = "";

      if (input.hasAttribute("required") && !value) {
        message = "This one's required.";
      } else if (input.type === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        message = "That doesn't look like a valid email.";
      }

      field.classList.toggle("is-invalid", !!message);
      if (error) error.textContent = message;
      return !message;
    }

    $$("input, textarea", form).forEach(function (input) {
      input.addEventListener("blur", function () { validate(input); });
      input.addEventListener("input", function () {
        var field = fieldOf(input);
        if (field && field.classList.contains("is-invalid")) validate(input);
      });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var inputs = $$("input[required], textarea[required]", form);
      var ok = true;
      var firstBad = null;
      inputs.forEach(function (input) {
        if (!validate(input)) {
          ok = false;
          if (!firstBad) firstBad = input;
        }
      });

      if (!ok) {
        if (note) { note.textContent = "Almost — a couple of fields need attention."; note.classList.remove("is-ok"); }
        if (firstBad) firstBad.focus();
        return;
      }

      // No backend in this static build: wire this up to your CRM / form
      // endpoint (HubSpot, Formspree, a serverless function, …).
      var submit = $("button[type='submit']", form);
      var label = submit ? $("span", submit) : null;
      if (label) label.textContent = "Sending…";
      window.setTimeout(function () {
        form.reset();
        if (label) label.textContent = "Request a strategy call";
        if (note) {
          note.textContent = "Thanks — we'll be in touch within one business day.";
          note.classList.add("is-ok");
          window.setTimeout(function () {
            note.textContent = defaultNote;
            note.classList.remove("is-ok");
          }, 6000);
        }
      }, 900);
    });
  }

  /* ============================================================ hero mesh */
  var canvas = $("[data-mesh]");
  var mesh = null;
  var drawMesh = null;   // assigned below; the master loop needs it in scope

  if (canvas && !reduced) {
    var ctx = canvas.getContext("2d");
    mesh = {
      nodes: [],
      w: 0, h: 0, dpr: 1,
      visible: true,
      pointer: { x: -9999, y: -9999 }
    };

    function sizeMesh() {
      var rect = canvas.getBoundingClientRect();
      mesh.dpr = Math.min(window.devicePixelRatio || 1, 2);
      mesh.w = rect.width;
      mesh.h = rect.height;
      canvas.width = Math.round(mesh.w * mesh.dpr);
      canvas.height = Math.round(mesh.h * mesh.dpr);
      ctx.setTransform(mesh.dpr, 0, 0, mesh.dpr, 0, 0);
      buildNodes();
    }

    function buildNodes() {
      // Density scales with area but stays capped so phones stay smooth.
      var count = clamp(Math.round((mesh.w * mesh.h) / 15000), 26, 92);
      mesh.nodes = [];
      for (var i = 0; i < count; i++) {
        mesh.nodes.push({
          x: Math.random() * mesh.w,
          y: Math.random() * mesh.h,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: Math.random() * 1.5 + 0.7
        });
      }
    }

    drawMesh = function () {
      if (!mesh.visible || !mesh.w) return;
      ctx.clearRect(0, 0, mesh.w, mesh.h);

      var nodes = mesh.nodes;
      var linkDist = Math.min(170, Math.max(110, mesh.w * 0.11));

      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.x += n.vx;
        n.y += n.vy;

        if (n.x < -20) n.x = mesh.w + 20;
        if (n.x > mesh.w + 20) n.x = -20;
        if (n.y < -20) n.y = mesh.h + 20;
        if (n.y > mesh.h + 20) n.y = -20;

        // gentle drift away from the cursor
        var pdx = n.x - mesh.pointer.x;
        var pdy = n.y - mesh.pointer.y;
        var pd2 = pdx * pdx + pdy * pdy;
        if (pd2 < 20000 && pd2 > 0.01) {
          var pd = Math.sqrt(pd2);
          var push = (1 - pd / 141) * 0.9;
          n.x += (pdx / pd) * push;
          n.y += (pdy / pd) * push;
        }

        for (var j = i + 1; j < nodes.length; j++) {
          var m = nodes[j];
          var dx = n.x - m.x;
          var dy = n.y - m.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < linkDist) {
            var alpha = (1 - d / linkDist) * 0.17;
            ctx.strokeStyle = "rgba(34, 38, 44, " + alpha.toFixed(3) + ")";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(m.x, m.y);
            ctx.stroke();
          }
        }

        ctx.fillStyle = "rgba(10, 11, 13, 0.3)";
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    window.addEventListener("pointermove", function (e) {
      var rect = canvas.getBoundingClientRect();
      mesh.pointer.x = e.clientX - rect.left;
      mesh.pointer.y = e.clientY - rect.top;
    }, { passive: true });

    window.addEventListener("resize", sizeMesh);
    sizeMesh();

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        mesh.visible = entries[0].isIntersecting;
      }, { threshold: 0 }).observe(canvas);
    }
  }

  /* ========================================================== master loop */
  var frame = 0;
  function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;

    if (scroller.enabled && !scroller.animating) {
      var diff = scroller.target - scroller.current;
      if (Math.abs(diff) > 0.12) {
        scroller.current = lerp(scroller.current, scroller.target, scroller.ease);
        window.scrollTo(0, scroller.current);
      } else if (scroller.current !== scroller.target) {
        scroller.current = scroller.target;
        window.scrollTo(0, scroller.current);
      }
    }

    var y = window.scrollY;
    updateHeader(y);
    updateProgress(y);
    updateEngine();
    if (frame % 6 === 0) updateActiveNav(y);
    if (frame % 20 === 0) settlePassed();
    if (cursor && cursor._render) cursor._render();
    if (mesh && drawMesh) drawMesh();
    frame++;
  }
  requestAnimationFrame(loop);

  /* ============================================================== sundry */
  var yearEl = $("[data-year]");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // Land on the very top on reload rather than restoring mid-page.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
})();
