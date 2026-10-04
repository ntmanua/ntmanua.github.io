/*
 * Décor d'engrenages 3D – manua.dev
 * ------------------------------------------------------------------
 * Canvas WebGL fixe, placé DERRIÈRE le contenu (z-index: -1), transparent.
 * Les engrenages sont rendus dans la seule rampe vert pâle du site
 * (#8FB8AF → #E5EFE9), puis le canvas entier reçoit une faible opacité.
 * Sur la bande verte des expériences, le fond vert est appliqué en
 * « multiply » (voir index.html) : les engrenages y apparaissent
 * automatiquement en vert plus profond, ton sur ton.
 *
 * Mécanique : profils en développante (angle de pression 20°), même module
 * pour tout un train, phase calculée pour que chaque dent tombe dans un creux,
 * sens alternés et vitesses inversement proportionnelles au nombre de dents.
 *
 * Rendu à la demande : une image n'est calculée que lorsque le scroll
 * (ou son lissage) évolue, ou lors d'un redimensionnement.
 */
(function () {
  'use strict';

  /* ================= RÉGLAGES FACILES ================= */
  var GEAR_OPACITY = 0.26;        // opacité du décor (0 → invisible). ≤ 0.30 pour garder le contraste AA.
  var SCROLL_TO_PITCH = 0.22;     // px parcourus sur le cercle primitif par px de scroll (vitesse de rotation).
  var SMOOTHING_MS = 140;         // constante de temps du lissage (plus grand = plus « lourd »).
  var PARALLAX_PX = 70;           // amplitude du décalage vertical sur toute la page.
  var TILT = 0.10;                // inclinaison (radians) qui évolue avec le scroll.
  var MAX_PIXEL_RATIO = 1.5;      // plafond de résolution (performances).
  var COLOR_SHADOW = '#8FB8AF';   // faces à l'ombre (vert pâle du site)
  var COLOR_LIGHT = '#E5EFE9';    // faces éclairées (vert très pâle du site)
  // Nombre de roues : modifier les tableaux de LAYOUTS plus bas.
  /* ==================================================== */

  var scriptSrc = document.currentScript && document.currentScript.src;
  var debug = /[?&]gears-debug\b/.test(location.search);

  if (!scriptSrc || !('requestAnimationFrame' in window)) return;
  if (!hasWebGL()) return;

  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  /* -------- Dispositions (unités = module ; angles en degrés, écran, y vers le bas) --------
   * Chaque roue : z = nombre de dents.
   *   anchor(W, H, m) → position écran (px) du centre de la première roue.
   *   mesh: index de la roue menante, angle: direction parent → enfant.
   *   coaxial: index de la roue dont elle partage l'axe (roue étagée), plane: plan de profondeur.
   */
  var LAYOUTS = {
    wide: {
      module: function (W) { return clamp(W * 0.0058, 5.5, 10); },
      trains: [
        { // gauche, un peu plus loin (parallaxe plus lente)
          depth: -70, parallax: 0.7, tiltY: 0.16,
          anchor: function (W, H, m) { return [-8 * m, 0.25 * H]; },
          wheels: [
            { z: 40 },
            { z: 18, mesh: 0, angle: 70 },
            { z: 11, coaxial: 1, plane: 1 },
            { z: 30, mesh: 2, angle: 115, plane: 1 }
          ]
        },
        { // droite
          depth: 0, parallax: 1, tiltY: -0.16,
          anchor: function (W, H, m) { return [W + 4.5 * m, 0.66 * H]; },
          wheels: [
            { z: 48 },
            { z: 16, mesh: 0, angle: -105 },
            { z: 26, mesh: 1, angle: -60 },
            { z: 14, mesh: 0, angle: 115 }
          ]
        }
      ]
    },
    narrow: {
      module: function (W) { return clamp(W * 0.0135, 4, 6.5); },
      trains: [
        {
          depth: -40, parallax: 0.7, tiltY: 0.14,
          anchor: function (W, H, m) { return [-9 * m, 0.34 * H]; },
          wheels: [
            { z: 30 },
            { z: 14, mesh: 0, angle: 62 }
          ]
        },
        {
          depth: 0, parallax: 1, tiltY: -0.14,
          anchor: function (W, H, m) { return [W + 11 * m, 0.74 * H]; },
          wheels: [
            { z: 36 },
            { z: 16, mesh: 0, angle: -118 }
          ]
        }
      ]
    }
  };

  var THICKNESS = 2.2;   // épaisseur d'une roue (modules)
  var PLANE_GAP = 0.35;  // jeu entre deux plans de roues

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // Three.js est chargé comme script classique (et non par import()) :
  // cela fonctionne aussi en ouvrant index.html directement depuis le disque (file://),
  // où les navigateurs bloquent les modules ES.
  var start = function () {
    if (window.__gearsThree) { init(window.__gearsThree); return; }
    var s = document.createElement('script');
    s.src = new URL('three.gears.min.js', scriptSrc).href;
    s.async = true;
    s.onload = function () {
      if (window.__gearsThree) init(window.__gearsThree);
    };
    s.onerror = function () { if (debug) console.error('[gears] three.gears.min.js introuvable'); };
    document.head.appendChild(s);
  };
  // Après le chargement complet et pendant un temps mort : aucun impact sur le LCP.
  var whenIdle = function () {
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2000 });
    else setTimeout(start, 200);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });

  /* ============================== INIT ============================== */
  function init(THREE) {
    var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    var narrowQuery = window.matchMedia('(max-width: 720px)');
    var lowEnd = narrowQuery.matches ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4);

    var canvas = document.createElement('canvas');
    canvas.className = 'gear-backdrop';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');
    canvas.tabIndex = -1;

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, alpha: true, antialias: !lowEnd,
        powerPreference: 'low-power', premultipliedAlpha: true,
        preserveDrawingBuffer: debug
      });
    } catch (e) { if (debug) console.error('[gears]', e); return; }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(30, 1, 10, 10000);

    var material = new THREE.ShaderMaterial({
      uniforms: {
        uShadow: { value: new THREE.Color(COLOR_SHADOW) },
        uLight: { value: new THREE.Color(COLOR_LIGHT) }
      },
      vertexShader: [
        'varying vec3 vN;',
        'varying float vR;',
        'void main() {',
        '  vN = normalize(normalMatrix * normal);',
        '  vR = length(position.xy);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      // Couleurs écrites telles quelles (sRGB) : la sortie reste strictement dans la palette.
      fragmentShader: [
        'uniform vec3 uShadow;',
        'uniform vec3 uLight;',
        'varying vec3 vN;',
        'varying float vR;',
        'void main() {',
        '  vec3 n = normalize(vN);',
        '  vec3 L = normalize(vec3(-0.45, 0.62, 0.64));',
        '  float lambert = max(dot(n, L), 0.0);',
        '  float shade = 0.18 + 0.82 * lambert;',
        // Stries de tournage, uniquement sur les faces planes visibles.
        '  float face = smoothstep(0.92, 0.99, n.z);',
        '  shade += face * 0.035 * sin(vR * 9.0);',
        '  gl_FragColor = vec4(mix(uShadow, uLight, clamp(shade, 0.0, 1.0)), 1.0);',
        '}'
      ].join('\n')
    });
    // Le ShaderMaterial n'applique pas de conversion d'espace colorimétrique :
    // on fournit donc les valeurs sRGB brutes des couleurs du site.
    rawSRGB(material.uniforms.uShadow.value, COLOR_SHADOW);
    rawSRGB(material.uniforms.uLight.value, COLOR_LIGHT);

    var geometryCache = {};
    var trains = [];
    var layoutKey = null;
    var layoutModule = 0;

    /* ---------- Géométrie d'une roue (en modules) ---------- */
    function wheelGeometry(z) {
      if (geometryCache[z]) return geometryCache[z];
      var q = lowEnd ? { flank: 3, bevel: 1, curve: 5 } : { flank: 6, bevel: 2, curve: 8 };
      var shape = gearShape(THREE, z, q.flank);
      var dims = gearDims(z);
      addHoles(THREE, shape, z, dims, q.curve);
      var body = new THREE.ExtrudeGeometry(shape, {
        depth: THICKNESS, curveSegments: q.curve, steps: 1,
        bevelEnabled: true, bevelThickness: 0.28, bevelSize: 0.22,
        bevelOffset: -0.22, bevelSegments: q.bevel
      });
      body.translate(0, 0, -THICKNESS / 2);

      // Moyeu en relief des deux côtés.
      var hub = new THREE.Shape();
      hub.absarc(0, 0, dims.hub, 0, Math.PI * 2, false);
      var bore = new THREE.Path();
      bore.absarc(0, 0, dims.bore, 0, Math.PI * 2, true);
      hub.holes.push(bore);
      var hubDepth = THICKNESS + 1.0;
      var hubGeo = new THREE.ExtrudeGeometry(hub, {
        depth: hubDepth, curveSegments: q.curve * 2, steps: 1,
        bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.16,
        bevelOffset: -0.16, bevelSegments: q.bevel
      });
      hubGeo.translate(0, 0, -hubDepth / 2);
      geometryCache[z] = { body: body, hub: hubGeo, dims: dims };
      return geometryCache[z];
    }

    /* ---------- Construction d'une disposition ---------- */
    function build(W, H) {
      var key = narrowQuery.matches ? 'narrow' : 'wide';
      var layout = LAYOUTS[key];
      var m = layout.module(W);
      clearTrains();
      layoutKey = key;
      layoutModule = m;

      layout.trains.forEach(function (spec) {
        var group = new THREE.Group();
        var a = spec.anchor(W, H, m);
        var wheels = [];
        spec.wheels.forEach(function (w, i) {
          var g = wheelGeometry(w.z);
          var plane = w.plane || 0;
          var x = 0, y = 0, alpha = 0;
          if (i > 0 && w.coaxial !== undefined) {
            x = wheels[w.coaxial].x; y = wheels[w.coaxial].y;
          } else if (i > 0) {
            var p = wheels[w.mesh];
            var d = (p.z + w.z) / 2;           // entraxe = m (z1 + z2) / 2
            alpha = -w.angle * Math.PI / 180;  // écran (y bas) → monde (y haut)
            x = p.x + d * Math.cos(alpha);
            y = p.y + d * Math.sin(alpha);
          }
          var holder = new THREE.Group();
          holder.position.set(x, y, plane * (THICKNESS + PLANE_GAP));
          var body = new THREE.Mesh(g.body, material);
          var hub = new THREE.Mesh(g.hub, material);
          holder.add(body); holder.add(hub);
          group.add(holder);
          wheels.push({ z: w.z, x: x, y: y, alpha: alpha, spec: w, holder: holder, dims: g.dims, plane: plane, theta: 0 });
        });
        group.scale.setScalar(m);
        scene.add(group);
        trains.push({ spec: spec, group: group, wheels: wheels, anchor: a });
      });
      if (debug) window.__gears = {
        trains: trains, checks: checkLayout(), m: m, key: key,
        // Projection écran (px CSS) d'un point exprimé en modules dans le repère d'un train.
        project: function (ti, x, y, zPlane) {
          var g = trains[ti].group;
          g.updateMatrixWorld(true);
          var v = new THREE.Vector3(x, y, zPlane || 0).applyMatrix4(g.matrixWorld).project(camera);
          return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
        }
      };
    }

    function clearTrains() {
      trains.forEach(function (t) { scene.remove(t.group); });
      trains = [];
    }

    /* ---------- Engrènement : angle de chaque roue ---------- */
    function setAngles(train, theta0) {
      var w = train.wheels;
      w[0].theta = theta0;
      for (var i = 1; i < w.length; i++) {
        var s = w[i].spec;
        if (s.coaxial !== undefined) { w[i].theta = w[s.coaxial].theta; continue; }
        var p = w[s.mesh];
        var a = w[i].alpha;
        // Quand une dent du parent pointe vers l'enfant, l'enfant présente un creux :
        // θc = α + π + π/zc − (zp/zc)(θp − α)
        w[i].theta = a + Math.PI + Math.PI / w[i].z - (p.z / w[i].z) * (p.theta - a);
      }
      for (var j = 0; j < w.length; j++) w[j].holder.rotation.z = w[j].theta;
    }

    /* ---------- Contrôle des collisions (mode debug) ---------- */
    function checkLayout() {
      var issues = [];
      trains.forEach(function (t, ti) {
        var w = t.wheels;
        for (var i = 0; i < w.length; i++) for (var j = i + 1; j < w.length; j++) {
          if (w[i].plane !== w[j].plane) continue;
          if (w[j].spec.mesh === i || w[i].spec.mesh === j) continue;
          var d = Math.hypot(w[i].x - w[j].x, w[i].y - w[j].y);
          var need = w[i].dims.ra + w[j].dims.ra + 0.5;
          if (d < need) issues.push('train ' + ti + ': roues ' + i + '/' + j + ' d=' + d.toFixed(2) + ' < ' + need.toFixed(2));
        }
      });
      return issues;
    }

    /* ---------- Caméra : 1 unité monde = 1 px CSS au plan z = 0 ---------- */
    var W = 0, H = 0;
    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      var dist = (H / 2) / Math.tan(camera.fov * Math.PI / 360);
      camera.position.set(0, 0, dist);
      camera.near = dist * 0.3; camera.far = dist * 2;
      camera.updateProjectionMatrix();
      var key = narrowQuery.matches ? 'narrow' : 'wide';
      if (key !== layoutKey || Math.abs(LAYOUTS[key].module(W) - layoutModule) > 0.01 || trains.length === 0) build(W, H);
      else trains.forEach(function (t) { t.anchor = t.spec.anchor(W, H, layoutModule); });
    }

    function place(train, scroll, progress) {
      var s = train.spec, a = train.anchor;
      var drift = (progress - 0.5) * PARALLAX_PX * s.parallax;
      train.group.position.set(a[0] - W / 2, H / 2 - a[1] + drift, s.depth);
      train.group.rotation.set((progress - 0.5) * TILT, s.tiltY, 0);
      var r0 = train.wheels[0].z / 2 * layoutModule;   // rayon primitif en px
      var sign = s.depth < 0 ? 1 : -1;
      setAngles(train, sign * scroll * SCROLL_TO_PITCH / r0);
    }

    /* ---------- Boucle à la demande ---------- */
    var reduced = motionQuery.matches;
    var target = window.scrollY, current = reduced ? 0 : target;
    var raf = 0, last = 0, alive = true, shown = false;

    function maxScroll() { return Math.max(1, document.documentElement.scrollHeight - H); }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      now = now || performance.now();
      var dt = last ? Math.min(64, now - last) : 16;
      last = now;
      if (!reduced) {
        var k = 1 - Math.exp(-dt / SMOOTHING_MS);
        current += (target - current) * k;
        if (Math.abs(target - current) < 0.25) current = target;
      }
      var s = reduced ? 0 : current;
      var p = reduced ? 0.5 : clamp(s / maxScroll(), 0, 1);
      for (var i = 0; i < trains.length; i++) place(trains[i], s, p);
      renderer.render(scene, camera);
      if (!shown) {
        shown = true;
        canvas.style.opacity = String(GEAR_OPACITY);
        document.documentElement.classList.add('gears-live');
      }
      if (!reduced && current !== target && !document.hidden) schedule(); else last = 0;
    }

    function schedule() { if (!raf && alive && !document.hidden) raf = requestAnimationFrame(frame); }

    function onScroll() { target = window.scrollY; if (!reduced) schedule(); }
    var resizeQueued = false;
    function onResize() {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(function () { resizeQueued = false; if (!alive) return; resize(); last = 0; frame(); });
    }
    function onVisibility() {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
      else { target = window.scrollY; schedule(); }
    }
    function onMotion() { reduced = motionQuery.matches; current = target; last = 0; frame(); }

    function teardown() {
      if (!alive) return;
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener && motionQuery.removeEventListener('change', onMotion);
      clearTrains();
      Object.keys(geometryCache).forEach(function (k) { geometryCache[k].body.dispose(); geometryCache[k].hub.dispose(); });
      material.dispose();
      renderer.dispose();
      document.documentElement.classList.remove('gears-live');
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); teardown(); }, false);
    window.addEventListener('pagehide', function (e) { if (!e.persisted) teardown(); });

    try {
      document.body.insertBefore(canvas, document.body.firstChild);
      resize();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVisibility);
      if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotion);
      frame();
    } catch (e) {
      if (debug) console.error('[gears]', e);
      teardown();
    }
  }

  /* ============================ GÉOMÉTRIE ============================ */
  function rawSRGB(color, hex) {
    var n = parseInt(hex.slice(1), 16);
    color.r = ((n >> 16) & 255) / 255; color.g = ((n >> 8) & 255) / 255; color.b = (n & 255) / 255;
  }

  function gearDims(z) {
    var r = z / 2;
    var rf = r - 1.25;
    var bore = Math.max(1.1, rf * 0.16);
    return {
      r: r, ra: r + 1, rf: rf, rb: r * Math.cos(20 * Math.PI / 180),
      bore: bore, hub: bore * 1.85
    };
  }

  // Profil en développante de cercle, angle de pression 20°, petit jeu de fonctionnement.
  function gearShape(THREE, z, flankSteps) {
    var d = gearDims(z);
    var alpha0 = 20 * Math.PI / 180;
    var inv = function (a) { return Math.tan(a) - a; };
    var backlash = 0.06;
    var halfPitch = (Math.PI / 2 - backlash) / (2 * d.r);   // demi-épaisseur angulaire au primitif
    var psi = function (rr) {
      var rrr = Math.max(rr, d.rb);
      return halfPitch + inv(alpha0) - inv(Math.acos(d.rb / rrr));
    };
    var r0 = Math.max(d.rb, d.rf);
    var pts = [];
    var step = 2 * Math.PI / z;
    var push = function (rr, ang) { pts.push([rr * Math.cos(ang), rr * Math.sin(ang)]); };

    for (var k = 0; k < z; k++) {
      var c = k * step;
      // flanc gauche (angle croissant)
      if (d.rf < d.rb) push(d.rf, c - psi(d.rb));
      for (var i = 0; i <= flankSteps; i++) {
        var rr = r0 + (d.ra - r0) * Math.pow(i / flankSteps, 0.85);
        push(rr, c - psi(rr));
      }
      // sommet
      push(d.ra, c);
      // flanc droit
      for (var j = flankSteps; j >= 0; j--) {
        var r2 = r0 + (d.ra - r0) * Math.pow(j / flankSteps, 0.85);
        push(r2, c + psi(r2));
      }
      if (d.rf < d.rb) push(d.rf, c + psi(d.rb));
      // fond de dent arrondi
      var a1 = c + psi(r0), a2 = c + step - psi(r0);
      var rootR = d.rf;
      for (var t = 1; t <= 2; t++) push(rootR - 0.08 * Math.sin(Math.PI * t / 3), a1 + (a2 - a1) * t / 3);
    }
    var shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (var p = 1; p < pts.length; p++) shape.lineTo(pts[p][0], pts[p][1]);
    shape.closePath();
    return shape;
  }

  // Alésage + allègements (bras pour les grandes roues, trous ronds pour les moyennes).
  function addHoles(THREE, shape, z, d, curve) {
    var bore = new THREE.Path();
    bore.absarc(0, 0, d.bore, 0, Math.PI * 2, true);
    shape.holes.push(bore);

    var rimIn = d.rf - 1.6;
    var hubOut = d.hub + 0.9;
    if (z >= 26 && rimIn - hubOut > 3) {
      var n = z >= 40 ? 6 : 5;
      var spoke = Math.max(1.3, rimIn * 0.16);
      var seg = Math.max(6, curve);
      for (var k = 0; k < n; k++) {
        var a0 = (k / n) * Math.PI * 2 + Math.PI / n * 0.5;
        var a1 = a0 + (Math.PI * 2) / n;
        var oS = a0 + spoke / 2 / rimIn, oE = a1 - spoke / 2 / rimIn;
        var iS = a0 + spoke / 2 / hubOut, iE = a1 - spoke / 2 / hubOut;
        if (iE - iS < 0.15) continue;
        var w = new THREE.Path();
        var i;
        // parcours horaire (trou)
        w.moveTo(rimIn * Math.cos(oE), rimIn * Math.sin(oE));
        for (i = 1; i <= seg; i++) {
          var a = oE + (oS - oE) * i / seg;
          w.lineTo(rimIn * Math.cos(a), rimIn * Math.sin(a));
        }
        for (i = 0; i <= Math.ceil(seg / 2); i++) {
          var b = iS + (iE - iS) * i / Math.ceil(seg / 2);
          w.lineTo(hubOut * Math.cos(b), hubOut * Math.sin(b));
        }
        w.closePath();
        shape.holes.push(w);
      }
    } else if (z >= 14) {
      var count = z >= 18 ? 5 : 4;
      var mid = (d.rf - 1.0 + d.hub) / 2;
      var hr = Math.min((d.rf - 1.0 - d.hub) * 0.32, mid * Math.sin(Math.PI / count) * 0.62);
      if (hr > 0.45) {
        for (var h = 0; h < count; h++) {
          var ang = (h / count) * Math.PI * 2 + Math.PI / count;
          var hole = new THREE.Path();
          hole.absarc(mid * Math.cos(ang), mid * Math.sin(ang), hr, 0, Math.PI * 2, true);
          shape.holes.push(hole);
        }
      }
    }
  }
})();
