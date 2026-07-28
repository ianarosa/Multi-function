/* sfx.js – shared procedural WebAudio sound module for all arcade games
 * Each game includes this script with:
 *   <script src="/sfx.js"></script>
 * and calls the global API, e.g.:
 *   SFX.play('coin', { combo: 3 });
 *
 * Pure oscillator/noise synthesis — NO external assets, NO network.
 * A floating mute toggle (🔊/🔇) is injected at the TOP-right so it never
 * overlaps leaderboard.js's trophy button (bottom-right).
 */
(function () {
  'use strict';

  var MUTE_KEY = 'arcade_muted';
  var VOL_KEY  = 'arcade_vol';    // localStorage: slider value 0..1

  /* ── Master volume / loudness ────────────────────────────────
   * The slider (0..1) drives the master GainNode through a mild
   * perceptual curve; MASTER_MAX is the actual gain at slider 1.0.
   * A soft limiter after the master keeps the louder default clean. */
  var MASTER_MAX   = 0.6;    // master GainNode value when slider == 1.0
  var VOL_DEFAULT  = 0.8;    // default slider position (noticeably louder than the old 0.35)
  var VOL_CURVE    = 1.4;    // gain = MASTER_MAX * pow(slider, VOL_CURVE)

  /* ── Master limiter (DynamicsCompressor as a soft limiter) ─── */
  var LIM_THRESHOLD = -8;    // dB
  var LIM_KNEE      = 6;     // dB
  var LIM_RATIO     = 10;    // :1
  var LIM_ATTACK    = 0.003; // s
  var LIM_RELEASE   = 0.25;  // s

  /* ── Per-play variation amounts (subtle — tune here) ─────── */
  var DETUNE_AMT     = 0.025;  // ±2.5% random pitch wobble per call
  var GAIN_WOBBLE    = 0.08;   // ±8%  random level wobble per call
  var START_JITTER   = 0.006;  // up to 6ms random start offset per call

  /* ── Shared reverb / space send ──────────────────────────── */
  var SEND_LEVEL     = 0.13;   // per-voice wet send (~13% of dry)
  var REVERB_SECONDS = 1.2;    // synthesized impulse length
  var REVERB_DECAY   = 2.5;    // impulse exponential decay steepness

  /* ── Generative background-music engine (tune here) ──────────
   * A slow arpeggiated bed on its OWN low-volume bus, mood chosen
   * deterministically from location.pathname so each page is stable
   * but distinct. Standard WebAudio lookahead scheduler. */
  var MUSIC_KEY         = 'arcade_music'; // localStorage: '1' on / '0' off (default on)
  var MUSIC_GAIN        = 0.08;   // music bus level — sits UNDER the SFX cues (~0.06–0.10)
  var MUSIC_BPM_MIN     = 70;     // mood tempos are clamped into this range
  var MUSIC_BPM_MAX     = 110;
  var MUSIC_LOOKAHEAD   = 0.1;    // s: schedule notes this far ahead
  var MUSIC_TICK        = 25;     // ms: scheduler wake interval
  var MUSIC_REVERB_SEND = 0.18;   // music → shared reverb send (a little space)
  var MUSIC_CUTOFF      = 1500;   // Hz: lowpass on the music bus (soft/warm)
  var MUSIC_PAD_DETUNE  = 6;      // cents: warm detune on the second pad layer
  var MUSIC_DRUM_GAIN   = 0.6;    // relative level of the soft kick/hat (groovy moods only)

  /* ── Per-game music-mood override ────────────────────────────
   * By default each game page hash-seeds its background-music mood from
   * location.pathname (stable but arbitrary). This table hand-picks a mood
   * for games where a specific vibe fits better than the random draw.
   * Keys are the game SLUG (first path segment, lowercased, e.g. the
   * '/void-dancer/' → 'void-dancer'). Values are indices into MOODS below
   * (0 = calm 'menu' bed, 1..7 = the game moods). Games not listed keep the
   * hash-seeded behavior; the hub ('/' or '/index.html') always forces 0.
   * Indices are range-guarded at lookup, so a bad value falls back safely. */
  var MOOD_OVERRIDE = {
    /* Ethereal / floaty / atmospheric — slower, no busy drums. */
    'void-dancer':   2,  // dream (lydian, 72bpm, sine, no drums) — delicate space-dodge
    /* Energetic / driving action — with drums. */
    'stellar-dash':  7,  // arcade (bright minor-pentatonic, drums) — fast Geometry-Dash runner
    'neon-breaker':  1,  // neon   (minor-pentatonic, 104bpm, drums) — arcade action
    'asteroid-blitz':7,  // arcade (bright, drums) — arcade shooter
    'river-run':     1,  // neon   (driving, drums) — arcade dodge/runner
    /* Groovy / rhythmic — with drums. */
    'snake-neon':    5,  // groove (mixolydian, square, drums) — groovy classic
    'rhythm-pulse':  5,  // groove (most rhythmic/driving) — rhythm game
    /* Calm / ambient puzzles — no drums. */
    'memory-matrix': 3,  // dusk       (dorian, mellow) — memory puzzle
    'hex-sweep':     6,  // mystic     (harmonic minor, no drums) — puzzle
    'pipe-flow':     4,  // melancholy (aeolian, ambient) — calm puzzle
    /* Light, calm chance games. */
    'coin-flip':     2,  // dream (light, airy)
    'dice-roll':     3   // dusk  (light, mellow)
  };

  var ctx = null;     // shared AudioContext (lazily created)
  var master = null;  // shared master GainNode
  var limiter = null; // shared master limiter (DynamicsCompressorNode)
  var reverb = null;  // shared reverb input node (ConvolverNode)
  var muted = false;

  /* Read persisted mute state (default = NOT muted). */
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { muted = false; }

  /* Read persisted volume slider (default = VOL_DEFAULT). */
  var volume = VOL_DEFAULT;
  try {
    var _sv = parseFloat(localStorage.getItem(VOL_KEY));
    if (isFinite(_sv)) volume = Math.max(0, Math.min(1, _sv));
  } catch (e) { volume = VOL_DEFAULT; }

  /* Slider position (0..1) → actual master gain, with the perceptual curve. */
  function sliderToGain(s) {
    var v = Math.max(0, Math.min(1, isFinite(s) ? s : 0));
    return MASTER_MAX * Math.pow(v, VOL_CURVE);
  }

  /* Push the current volume/mute state onto the live master gain (guarded). */
  function applyMasterGain() {
    if (!ctx || !master) return;
    try {
      var g = muted ? 0.0001 : Math.max(0.0001, sliderToGain(volume));
      master.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
    } catch (e) {
      try { master.gain.value = muted ? 0 : sliderToGain(volume); } catch (e2) {}
    }
  }

  /* ── AudioContext lifecycle ──────────────────────────────── */
  function unlock() {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;               // no WebAudio support → all methods no-op
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : sliderToGain(volume);
        /* Soft limiter between the master and the speakers so the louder
         * default punches without ugly clipping. Reverb + musicBus feed
         * master, so they get limited too. Degrades to a direct connection. */
        try {
          if (typeof ctx.createDynamicsCompressor === 'function') {
            limiter = ctx.createDynamicsCompressor();
            limiter.threshold.value = LIM_THRESHOLD;
            limiter.knee.value      = LIM_KNEE;
            limiter.ratio.value     = LIM_RATIO;
            limiter.attack.value    = LIM_ATTACK;
            limiter.release.value   = LIM_RELEASE;
            master.connect(limiter);
            limiter.connect(ctx.destination);
          } else {
            master.connect(ctx.destination);
          }
        } catch (e) {
          limiter = null;
          try { master.connect(ctx.destination); } catch (e2) {}
        }
        buildReverb();               // shared space bus, built once
        buildMusicBus();             // low-volume music bus, built once
        /* When the context flips to 'running' (resume resolves), start the
         * bed if enabled — covers browsers that resume asynchronously. */
        ctx.onstatechange = function () {
          if (ctx && ctx.state === 'running') maybeStartMusic();
        };
      }
      if (ctx.state === 'suspended') ctx.resume();
      maybeStartMusic();             // start now if already running + enabled
    } catch (e) { /* never throw from unlock() */ }
  }

  /* Lazily build a lightweight algorithmic reverb from a synthesized,
   * exponentially-decaying noise impulse (no external asset). Routed as a
   * parallel SEND: dry stays voiceGain->master; wet is voiceGain->send->reverb->master.
   * Built once; degrades to no reverb if anything is unavailable. */
  function buildReverb() {
    if (reverb || !ctx || !master) return;
    try {
      var rate = ctx.sampleRate;
      var len = Math.max(1, Math.floor(REVERB_SECONDS * rate));
      var imp = ctx.createBuffer(2, len, rate);
      for (var c = 0; c < 2; c++) {
        var ch = imp.getChannelData(c);
        for (var i = 0; i < len; i++) {
          ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, REVERB_DECAY);
        }
      }
      var conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = imp;
      conv.connect(master);          // wet return (send level set per voice)
      reverb = conv;
    } catch (e) { reverb = null; }    // no reverb → dry-only, still works
  }

  /* A per-voice send gain into the shared reverb, or null if unavailable.
   * Returned so the caller's onended handler can disconnect it (no leaks). */
  function sendNode(mult) {
    if (!reverb) return null;
    var sg = ctx.createGain();
    sg.gain.value = SEND_LEVEL * (mult != null ? mult : 1);
    sg.connect(reverb);
    return sg;
  }

  /* Small per-play randomizers so repeated cues don't phase-lock / sound robotic. */
  function detuneFactor() { return 1 + (Math.random() * 2 - 1) * DETUNE_AMT; }
  function wobbleGain(v)  { return v * (1 + (Math.random() * 2 - 1) * GAIN_WOBBLE); }
  function jitter()       { return Math.random() * START_JITTER; }

  /* Soft-clip waveshaper curve (tanh-ish), cached per drive amount.
   * Normalized to [-1,1] so it warms/punches without boosting level. */
  var shaperCurves = {};
  function shaperCurve(amount) {
    var key = amount.toFixed(3);
    if (shaperCurves[key]) return shaperCurves[key];
    var n = 1024, curve = new Float32Array(n), k = amount * 4 + 1;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    shaperCurves[key] = curve;
    return curve;
  }

  /* True only when we have a live, running context to play into. */
  function ready() {
    return !!(ctx && master && ctx.state === 'running');
  }

  /* ── Low-level synth helpers ─────────────────────────────── */

  /* One short oscillator note with an attack/decay envelope.
   * All nodes are stopped + disconnected on end (no leaks). */
  function tone(opts) {
    if (!ready()) return;
    var det = detuneFactor();               // subtle per-play pitch wobble
    var t0 = ctx.currentTime + (opts.delay || 0) + jitter();
    var type = opts.type || 'sine';
    var base = opts.freq || 440;
    var f0 = base * det;
    var f1 = ((opts.freqEnd != null) ? opts.freqEnd : base) * det;
    var dur = opts.dur || 0.12;
    var peak = wobbleGain(opts.gain != null ? opts.gain : 0.6);

    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);

    /* Optional warming chain for harsh voices: waveshaper drive (punch),
     * then a lowpass cutoff (tames buzz). Both before the gain envelope. */
    var head = osc, shaper = null, lp = null;
    if (opts.drive) {
      shaper = ctx.createWaveShaper();
      shaper.curve = shaperCurve(opts.drive);
      shaper.oversample = '2x';
      head.connect(shaper);
      head = shaper;
    }
    if (opts.cutoff) {
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = opts.cutoff;
      head.connect(lp);
      head = lp;
    }

    /* Quick attack, smooth exponential release. */
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    head.connect(g);
    g.connect(master);                      // dry path (unchanged)
    var sg = sendNode(opts.send);            // parallel wet send (opts.send scales it)
    if (sg) g.connect(sg);

    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = function () {
      try {
        osc.disconnect(); g.disconnect();
        if (shaper) shaper.disconnect();
        if (lp) lp.disconnect();
        if (sg) sg.disconnect();
      } catch (e) {}
    };
  }

  /* A burst of filtered white noise (explosions, whooshes, hits). */
  function noise(opts) {
    if (!ready()) return;
    var det = detuneFactor();               // subtle per-play timbre wobble
    var t0 = ctx.currentTime + (opts.delay || 0) + jitter();
    var dur = opts.dur || 0.2;
    var peak = wobbleGain(opts.gain != null ? opts.gain : 0.5);

    var frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    var src = ctx.createBufferSource();
    src.buffer = buf;

    var filt = ctx.createBiquadFilter();
    filt.type = opts.filterType || 'lowpass';
    filt.frequency.setValueAtTime((opts.f0 != null ? opts.f0 : 1200) * det, t0);
    if (opts.f1 != null) filt.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1 * det), t0 + dur);
    if (opts.q != null) filt.Q.value = opts.q;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filt);
    filt.connect(g);
    g.connect(master);                      // dry path (unchanged)
    var sg = sendNode(opts.send);            // parallel wet send (opts.send scales it)
    if (sg) g.connect(sg);

    src.start(t0);
    src.stop(t0 + dur + 0.02);
    src.onended = function () {
      try {
        src.disconnect(); filt.disconnect(); g.disconnect();
        if (sg) sg.disconnect();
      } catch (e) {}
    };
  }

  /* ── Cue voices ──────────────────────────────────────────── */
  /* Each voice takes (vol, rate, combo): vol scales gain, rate multiplies
   * pitch, combo (>1) nudges pitch up a little per step (capped). */
  var voices = {
    click: function (vol, rate) {
      tone({ type: 'square', freq: 880 * rate, freqEnd: 660 * rate, dur: 0.05, gain: 0.35 * vol });
    },
    move: function (vol, rate) {
      tone({ type: 'triangle', freq: 520 * rate, dur: 0.045, gain: 0.3 * vol });
    },
    jump: function (vol, rate) {
      /* Rounder pitch-swept blip: triangle body + a soft sine sub for weight. */
      tone({ type: 'triangle', freq: 320 * rate, freqEnd: 760 * rate, dur: 0.15, gain: 0.4 * vol, cutoff: 3200 });
      tone({ type: 'sine', freq: 160 * rate, freqEnd: 380 * rate, dur: 0.12, gain: 0.22 * vol });
    },
    coin: function (vol, rate, combo) {
      var m = comboMul(combo);
      /* Bright two-note "ding" + a tiny sparkle harmonic above the second note. */
      tone({ type: 'square', freq: 988 * rate * m, dur: 0.06, gain: 0.4 * vol });
      tone({ type: 'square', freq: 1319 * rate * m, dur: 0.14, gain: 0.4 * vol, delay: 0.06 });
      tone({ type: 'sine', freq: 2637 * rate * m, dur: 0.08, gain: 0.12 * vol, delay: 0.06 });
    },
    shoot: function (vol, rate) {
      /* Snappier laser: a click transient, then a fast downward sweep. */
      noise({ filterType: 'highpass', f0: 3000, dur: 0.015, gain: 0.22 * vol });
      tone({ type: 'sawtooth', freq: 1500 * rate, freqEnd: 140 * rate, dur: 0.1, gain: 0.35 * vol, cutoff: 2600, drive: 0.5 });
    },
    hit: function (vol, rate) {
      /* Percussive "thwack": a short pitched body under a fast noise transient. */
      tone({ type: 'triangle', freq: 260 * rate, freqEnd: 70 * rate, dur: 0.09, gain: 0.5 * vol, cutoff: 2000, drive: 0.5 });
      noise({ filterType: 'bandpass', f0: 1600, f1: 300, q: 0.9, dur: 0.06, gain: 0.34 * vol });
    },
    explode: function (vol, rate) {
      /* Deeper boom: filtered noise body over a long low sine sweep, extra reverb. */
      noise({ filterType: 'lowpass', f0: 1400 * rate, f1: 60, dur: 0.45, gain: 0.55 * vol, send: 1.6 });
      tone({ type: 'sine', freq: 130 * rate, freqEnd: 32 * rate, dur: 0.5, gain: 0.55 * vol, drive: 0.4, send: 1.6 });
    },
    bounce: function (vol, rate) {
      tone({ type: 'sine', freq: 660 * rate, freqEnd: 990 * rate, dur: 0.07, gain: 0.4 * vol });
    },
    place: function (vol, rate) {
      tone({ type: 'triangle', freq: 200 * rate, freqEnd: 130 * rate, dur: 0.1, gain: 0.5 * vol });
      noise({ filterType: 'lowpass', f0: 400, dur: 0.05, gain: 0.15 * vol });
    },
    match: function (vol, rate) {
      tone({ type: 'sine', freq: 784 * rate, dur: 0.1, gain: 0.4 * vol });
      tone({ type: 'sine', freq: 1175 * rate, dur: 0.16, gain: 0.4 * vol, delay: 0.09 });
    },
    powerup: function (vol, rate) {
      /* Fuller ascending arpeggio: each note doubled with a detuned layer. */
      var notes = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < notes.length; i++) {
        var d = i * 0.05;
        tone({ type: 'triangle', freq: notes[i] * rate,         dur: 0.1, gain: 0.3 * vol, delay: d });
        tone({ type: 'sine',     freq: notes[i] * rate * 1.005, dur: 0.1, gain: 0.16 * vol, delay: d });
      }
    },
    levelup: function (vol, rate) {
      var notes = [523, 659, 784];   // C-E-G ascending arpeggio
      for (var i = 0; i < notes.length; i++) {
        var d = i * 0.1;
        tone({ type: 'square',   freq: notes[i] * rate,         dur: 0.14, gain: 0.34 * vol, delay: d });
        tone({ type: 'triangle', freq: notes[i] * rate * 1.006, dur: 0.14, gain: 0.18 * vol, delay: d });
      }
    },
    win: function (vol, rate) {
      var notes = [523, 659, 784, 1047];   // slightly longer, four notes
      for (var i = 0; i < notes.length; i++) {
        var d = i * 0.12;
        tone({ type: 'square',   freq: notes[i] * rate,         dur: 0.17, gain: 0.36 * vol, delay: d });
        tone({ type: 'triangle', freq: notes[i] * rate * 1.006, dur: 0.17, gain: 0.2 * vol, delay: d });
      }
    },
    gameover: function (vol, rate) {
      var notes = [523, 392, 311, 196];   // descending sweep
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'sawtooth', freq: notes[i] * rate, dur: 0.22, gain: 0.4 * vol, delay: i * 0.14 });
      }
    },
    tick: function (vol, rate) {
      tone({ type: 'square', freq: 1500 * rate, dur: 0.025, gain: 0.3 * vol });
    },
    error: function (vol, rate) {
      tone({ type: 'sawtooth', freq: 160 * rate, freqEnd: 110 * rate, dur: 0.22, gain: 0.4 * vol, cutoff: 1800, drive: 0.5 });
    },
    whoosh: function (vol, rate) {
      noise({ filterType: 'bandpass', f0: 300 * rate, f1: 2400 * rate, q: 1.2, dur: 0.3, gain: 0.45 * vol });
    },
    start: function (vol, rate) {
      tone({ type: 'square', freq: 587 * rate, dur: 0.08, gain: 0.4 * vol });
      tone({ type: 'square', freq: 880 * rate, dur: 0.14, gain: 0.42 * vol, delay: 0.08 });
    }
  };

  /* Combo pitch multiplier: +~6% per step above 1, capped. */
  function comboMul(combo) {
    var c = (combo && combo > 1) ? combo : 1;
    if (c > 8) c = 8;                 // cap so it never screeches
    return Math.pow(1.06, c - 1);
  }

  /* Aliases → canonical voice names. */
  var aliases = {
    select: 'click',
    score: 'coin',
    hurt: 'hit',
    damage: 'hit',
    merge: 'match',
    lose: 'gameover',
    dead: 'gameover',
    death: 'gameover'
    /* 'win' and 'levelup' are both real voices (win is a touch longer). */
  };

  /* ── Public play() ───────────────────────────────────────── */
  function play(name, opts) {
    try {
      if (muted || !ready() || !name) return;
      var key = aliases[name] || name;
      var voice = voices[key];
      if (!voice) return;             // unknown cue → safe no-op
      opts = opts || {};
      var vol = (opts.vol != null && isFinite(opts.vol)) ? opts.vol : 1;
      var rate = (opts.rate != null && isFinite(opts.rate) && opts.rate > 0) ? opts.rate : 1;
      voice(vol, rate, opts.combo);
    } catch (e) { /* never throw from play() */ }
  }

  /* ══════════════════════════════════════════════════════════
   *  GENERATIVE MUSIC ENGINE
   * ══════════════════════════════════════════════════════════ */

  /* Music toggle, persisted separately from SFX mute (default ON). */
  var musicEnabled = true;
  try { musicEnabled = localStorage.getItem(MUSIC_KEY) !== '0'; } catch (e) { musicEnabled = true; }

  var musicBus  = null;   // GainNode: the low-volume music bus → master
  var musicLP   = null;   // BiquadFilter: lowpass warmth in front of the bus
  var musicSend = null;   // GainNode: a little of the music into the reverb
  var musicTimer = null;  // setInterval handle for the lookahead scheduler
  var nextNoteTime = 0;   // WebAudio time of the next step to schedule
  var stepIndex = 0;      // running step counter (drives arp + chord walk)

  /* Deterministic 32-bit hash of a string (FNV-1a). */
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* Mood presets. scale = semitone offsets; root = bass frequency (Hz);
   * bpm = tempo; wave = lead timbre (mostly mellow); prog = scale-degree
   * indices the arp/chord walks through so it evolves, not a 4-note loop. */
  var MOODS = [
    /* 0 = HUB / menu: calm major-pentatonic bed, distinct from the games.
     * `drums:true` adds a subtle kick/hat groove; calmer moods stay ambient. */
    { name: 'menu',       scale: [0, 2, 4, 7, 9],            root: 220.00, bpm: 76,  wave: 'sine',     prog: [0, 3, 4, 2], drums: false },
    { name: 'neon',       scale: [0, 3, 5, 7, 10],           root: 196.00, bpm: 104, wave: 'triangle', prog: [0, 2, 3, 4], drums: true  }, // minor pentatonic
    { name: 'dream',      scale: [0, 2, 4, 6, 7, 9, 11],     root: 174.61, bpm: 72,  wave: 'sine',     prog: [0, 3, 4, 0], drums: false }, // lydian
    { name: 'dusk',       scale: [0, 2, 3, 5, 7, 9, 10],     root: 164.81, bpm: 88,  wave: 'triangle', prog: [0, 4, 3, 5], drums: false }, // dorian
    { name: 'melancholy', scale: [0, 2, 3, 5, 7, 8, 10],     root: 146.83, bpm: 80,  wave: 'sine',     prog: [0, 5, 3, 4], drums: false }, // aeolian
    { name: 'groove',     scale: [0, 2, 4, 5, 7, 9, 10],     root: 207.65, bpm: 100, wave: 'square',   prog: [0, 4, 5, 3], drums: true  }, // mixolydian
    { name: 'mystic',     scale: [0, 2, 3, 5, 7, 8, 11],     root: 185.00, bpm: 84,  wave: 'triangle', prog: [0, 3, 4, 6], drums: false }, // harmonic minor
    { name: 'arcade',     scale: [0, 3, 5, 7, 10],           root: 246.94, bpm: 96,  wave: 'triangle', prog: [0, 3, 2, 4], drums: true  }  // minor pentatonic, bright
  ];

  /* Current game's SLUG: the first non-empty path segment, lowercased.
   * '/void-dancer/' → 'void-dancer'; '/void-dancer/index.html' → 'void-dancer';
   * hub '/' or '/index.html' → '' (empty). Never throws. */
  function pageSlug() {
    try {
      var p = (location && location.pathname) || '/';
      var parts = p.split('/');
      for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (seg) return seg.toLowerCase();
      }
      return '';
    } catch (e) { return ''; }
  }

  /* Pick this page's mood: the hub always gets 'menu'; every other page uses a
   * per-game override when one is defined, else hashes its pathname to a stable
   * index into the game moods. */
  function pickMood() {
    var p = (location && location.pathname) || '/';
    var isHub = (p === '/' || p === '/index.html');
    var m;
    if (isHub) {
      m = MOODS[0];   // hub ALWAYS forces the calm menu bed
    } else {
      /* Hash-seeded default (unchanged for games without an override). */
      var idx = 1 + (hashStr(p) % (MOODS.length - 1));
      /* Per-game override, if the slug is mapped and the index is in range. */
      var slug = pageSlug();
      if (slug && Object.prototype.hasOwnProperty.call(MOOD_OVERRIDE, slug)) {
        var ov = MOOD_OVERRIDE[slug];
        if (typeof ov === 'number' && ov >= 0 && ov < MOODS.length) idx = ov;
      }
      m = MOODS[idx] || MOODS[1];   // final range-guard
    }
    /* Clamp tempo into the configured range (safety). */
    var bpm = Math.max(MUSIC_BPM_MIN, Math.min(MUSIC_BPM_MAX, m.bpm));
    return { name: m.name, scale: m.scale, root: m.root, bpm: bpm, wave: m.wave, prog: m.prog, drums: !!m.drums, index: MOODS.indexOf(m) };
  }

  var musicMood = pickMood();   // stable for the life of the page

  /* Frequency of a scale degree (may exceed the scale length → octaves). */
  function scaleFreq(degree) {
    var sc = musicMood.scale, n = sc.length;
    var oct = Math.floor(degree / n);
    var semi = sc[((degree % n) + n) % n] + 12 * oct;
    return musicMood.root * Math.pow(2, semi / 12);
  }

  var stepDur = function () { return (60 / musicMood.bpm) / 2; }; // eighth note

  /* Build the dedicated music bus once: lowpass → gain → master, plus a
   * small parallel send into the shared reverb. Degrades to no-op. */
  function buildMusicBus() {
    if (musicBus || !ctx || !master) return;
    try {
      musicBus = ctx.createGain();
      musicBus.gain.value = MUSIC_GAIN;
      musicBus.connect(master);

      musicLP = ctx.createBiquadFilter();
      musicLP.type = 'lowpass';
      musicLP.frequency.value = MUSIC_CUTOFF;
      musicLP.Q.value = 0.5;
      musicLP.connect(musicBus);

      if (reverb) {
        musicSend = ctx.createGain();
        musicSend.gain.value = MUSIC_REVERB_SEND;
        musicSend.connect(reverb);
      }
    } catch (e) { musicBus = null; musicLP = null; musicSend = null; }
  }

  /* One music note: softer, longer envelope than the punchy SFX cues.
   * Routed lead/pad/bass all through the lowpass bus (+ a little reverb).
   * Stops + disconnects on end (no node leaks). */
  function musicNote(when, freq, dur, gain, type) {
    if (!ctx || !musicBus || !musicLP) return;
    try {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = type || musicMood.wave;
      osc.frequency.setValueAtTime(Math.max(1, freq), when);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), when + Math.min(0.06, dur * 0.25));
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g);
      g.connect(musicLP);
      if (musicSend) g.connect(musicSend);
      osc.start(when);
      osc.stop(when + dur + 0.05);
      osc.onended = function () {
        try { osc.disconnect(); g.disconnect(); } catch (e) {}
      };
    } catch (e) { /* never throw */ }
  }

  /* A soft, low rhythmic element for the groovier moods only: a rounded kick
   * or a quiet high-passed hat. Routed straight to the music bus (bypassing the
   * warm lowpass so the hat keeps a little air), kept low in the mix. */
  function drumHit(when, kind) {
    if (!ctx || !musicBus) return;
    try {
      if (kind === 'kick') {
        var osc = ctx.createOscillator();
        var kg = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(120, when);
        osc.frequency.exponentialRampToValueAtTime(45, when + 0.09);
        kg.gain.setValueAtTime(0.0001, when);
        kg.gain.exponentialRampToValueAtTime(0.55 * MUSIC_DRUM_GAIN, when + 0.006);
        kg.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
        osc.connect(kg); kg.connect(musicBus);
        osc.start(when); osc.stop(when + 0.16);
        osc.onended = function () { try { osc.disconnect(); kg.disconnect(); } catch (e) {} };
      } else { // hat
        var dur = 0.03;
        var frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
        var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
        var src = ctx.createBufferSource(); src.buffer = buf;
        var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
        var hg = ctx.createGain();
        hg.gain.setValueAtTime(0.0001, when);
        hg.gain.exponentialRampToValueAtTime(0.1 * MUSIC_DRUM_GAIN, when + 0.003);
        hg.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        src.connect(hp); hp.connect(hg); hg.connect(musicBus);
        src.start(when); src.stop(when + dur + 0.02);
        src.onended = function () { try { src.disconnect(); hp.disconnect(); hg.disconnect(); } catch (e) {} };
      }
    } catch (e) { /* never throw */ }
  }

  /* Melodic lead: chord-tone indices (0=root, 1=third, 2=fifth) with rests so
   * the line breathes instead of machine-gunning. */
  var LEAD_TONE = [0, 2, 1, 2, 0, 1, 2, 1];
  var LEAD_MASK = [1, 0, 1, 1, 0, 1, 0, 1];   // 1 = play, 0 = rest
  var TRIAD_OFF = [0, 2, 4];                   // scale-degree offsets of the triad

  /* cents → frequency ratio (for the warm detuned pad layer). */
  function centsRatio(c) { return Math.pow(2, c / 1200); }

  /* Schedule everything that happens on step `s` at time `when`. */
  function scheduleStep(when, s) {
    var mood = musicMood;
    var chordIdx = Math.floor(s / 16) % mood.prog.length; // chord changes every 16 steps
    var deg = mood.prog[chordIdx];
    var beat = 60 / mood.bpm;
    var detune = centsRatio(MUSIC_PAD_DETUNE);

    /* Chord change: bass + a soft sustained pad triad, each pad tone doubled
     * with a gently detuned layer for warmth; a 7th adds colour on alt chords. */
    if (s % 16 === 0) {
      musicNote(when, scaleFreq(deg) / 2, beat * 3.5, 0.5, 'triangle'); // bass, one octave under root
      var padDur = beat * 3.6;
      for (var t = 0; t < TRIAD_OFF.length; t++) {
        var f = scaleFreq(deg + TRIAD_OFF[t]);
        musicNote(when, f,          padDur, 0.09, 'sine');  // pad layer
        musicNote(when, f * detune, padDur, 0.05, 'sine');  // warm detuned layer
      }
      if (chordIdx % 2 === 1) {
        musicNote(when, scaleFreq(deg + 6), padDur, 0.05, 'sine'); // 7th colour tone
      }
    }

    /* Lead: follows the current chord (chord tones + occasional passing scale
     * note), an octave up, humanized in velocity + timing, with rests. */
    var pos = s % LEAD_MASK.length;
    if (LEAD_MASK[pos]) {
      var leadDeg = deg + TRIAD_OFF[LEAD_TONE[pos]];
      if (Math.random() < 0.22) leadDeg += 1;   // passing scale tone for movement
      leadDeg += mood.scale.length;             // +1 octave
      var vel = 0.15 * (0.85 + Math.random() * 0.3);
      var tj = (Math.random() * 2 - 1) * 0.008;
      musicNote(when + Math.max(0, tj), scaleFreq(leadDeg), beat * 0.85, vel, mood.wave);
    }

    /* Groove: subtle kick on the beat, hat on the off-eighth (groovy moods only). */
    if (mood.drums) {
      if (s % 4 === 0) drumHit(when, 'kick');
      else if (s % 2 === 0) drumHit(when, 'hat');
    }
  }

  /* Lookahead scheduler — the "A Tale of Two Clocks" pattern: a coarse
   * setInterval wakes us, and we schedule every note whose time falls
   * inside the lookahead window, advancing nextNoteTime by one step. */
  function scheduler() {
    if (!musicTimer || !ctx) return;
    try {
      while (nextNoteTime < ctx.currentTime + MUSIC_LOOKAHEAD) {
        scheduleStep(nextNoteTime, stepIndex);
        nextNoteTime += stepDur();
        stepIndex++;
      }
    } catch (e) { /* never throw from the scheduler */ }
  }

  /* Start the scheduler iff music is enabled, not master-muted, audio is
   * live, and it isn't already running. Safe to call repeatedly. */
  function maybeStartMusic() {
    try {
      if (!musicEnabled || muted) return;
      if (!ready() || !musicBus) return;
      if (musicTimer) return;
      stepIndex = 0;
      nextNoteTime = ctx.currentTime + 0.15;
      musicTimer = setInterval(scheduler, MUSIC_TICK);
      reflectMusicState();
    } catch (e) {}
  }

  /* Stop scheduling; already-scheduled tails ring out naturally. */
  function haltMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    reflectMusicState();
  }

  /* Reflect running state onto the button (glyph + a testable data-attr). */
  function reflectMusicState() {
    if (musicBtn) {
      musicBtn.textContent = musicEnabled ? '🎵' : '🔕';
      musicBtn.setAttribute('data-active', musicTimer ? '1' : '0');
    }
  }

  function persistMusic() {
    try { localStorage.setItem(MUSIC_KEY, musicEnabled ? '1' : '0'); } catch (e) {}
  }

  /* ── Public music API ────────────────────────────────────── */
  function startMusic() { musicEnabled = true; persistMusic(); reflectMusicState(); maybeStartMusic(); }
  function stopMusic()  { haltMusic(); }
  function setMusic(v) {
    musicEnabled = !!v;
    persistMusic();
    reflectMusicState();
    if (musicEnabled) maybeStartMusic(); else haltMusic();
  }
  function isMusicOn() { return musicEnabled; }

  /* ── Top-right control cluster (clear of the trophy at bottom-right) ── */
  var btn = null;        // mute button
  var musicBtn = null;   // music button
  var volSlider = null;  // master volume slider

  function injectButton() {
    var style = document.createElement('style');
    style.textContent = [
      /* Mute button: rightmost. */
      '#sfx-mute{position:fixed;top:12px;right:12px;z-index:9998;',
      'background:#0a0a12;border:1px solid #ffffff33;border-radius:6px;',
      'color:#fff;font-size:1rem;line-height:1;font-family:Barlow,sans-serif;',
      'width:34px;height:34px;padding:0;cursor:pointer;',
      'box-shadow:0 0 12px #00000055;transition:background .15s,border-color .15s;}',
      '#sfx-mute:hover{background:#ffffff14;border-color:#ffffff66;}',
      /* Music toggle: same styling, sits just LEFT of the mute button. */
      '#sfx-music{position:fixed;top:12px;right:54px;z-index:9998;',
      'background:#0a0a12;border:1px solid #ffffff33;border-radius:6px;',
      'color:#fff;font-size:1rem;line-height:1;font-family:Barlow,sans-serif;',
      'width:34px;height:34px;padding:0;cursor:pointer;',
      'box-shadow:0 0 12px #00000055;transition:background .15s,border-color .15s;}',
      '#sfx-music:hover{background:#ffffff14;border-color:#ffffff66;}',
      /* Volume slider: horizontal, to the LEFT of the two buttons. */
      '#sfx-vol{position:fixed;top:12px;right:92px;z-index:9998;',
      'width:96px;height:34px;margin:0;padding:0 8px;box-sizing:border-box;',
      'background:#0a0a12;border:1px solid #ffffff33;border-radius:6px;',
      'box-shadow:0 0 12px #00000055;cursor:pointer;vertical-align:middle;',
      'touch-action:none;',
      '-webkit-appearance:none;appearance:none;transition:border-color .15s;}',
      '#sfx-vol:hover{border-color:#ffffff66;}',
      /* WebKit track + thumb (slim neon track, glowing thumb). */
      '#sfx-vol::-webkit-slider-runnable-track{height:4px;border-radius:3px;',
      'background:linear-gradient(90deg,#4df3ff 0%,#2a8fae 60%,#ffffff22 60%);}',
      '#sfx-vol::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
      'width:12px;height:12px;margin-top:-4px;border-radius:50%;',
      'background:#4df3ff;border:1px solid #0a0a12;',
      'box-shadow:0 0 8px #4df3ffcc;cursor:pointer;}',
      /* Firefox track + thumb. */
      '#sfx-vol::-moz-range-track{height:4px;border-radius:3px;background:#ffffff22;}',
      '#sfx-vol::-moz-range-progress{height:4px;border-radius:3px;background:#4df3ff;}',
      '#sfx-vol::-moz-range-thumb{width:12px;height:12px;border-radius:50%;',
      'background:#4df3ff;border:1px solid #0a0a12;box-shadow:0 0 8px #4df3ffcc;cursor:pointer;}'
    ].join('');
    document.head.appendChild(style);

    volSlider = document.createElement('input');
    volSlider.id = 'sfx-vol';
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.01';
    volSlider.value = String(volume);
    volSlider.title = 'Volume';
    volSlider.setAttribute('aria-label', 'Master volume');
    var onSlide = function () {
      unlock();          // interacting is a valid gesture to unlock audio
      var v = parseFloat(volSlider.value);
      if (!isFinite(v)) return;
      volume = Math.max(0, Math.min(1, v));
      persistVolume();
      /* Dragging above 0 clears mute; 0 = effectively silent (still not "muted"). */
      if (volume > 0 && muted) { setMuted(false); }
      else { applyMasterGain(); }
    };
    volSlider.addEventListener('input', onSlide);
    volSlider.addEventListener('change', onSlide);

    btn = document.createElement('button');
    btn.id = 'sfx-mute';
    btn.type = 'button';
    btn.title = 'Toggle sound';
    btn.setAttribute('aria-label', 'Toggle sound');
    updateGlyph();
    btn.addEventListener('click', function () {
      unlock();          // a click is a valid user gesture to unlock audio
      toggleMute();
    });

    musicBtn = document.createElement('button');
    musicBtn.id = 'sfx-music';
    musicBtn.type = 'button';
    musicBtn.title = 'Toggle music';
    musicBtn.setAttribute('aria-label', 'Toggle music');
    musicBtn.addEventListener('click', function () {
      unlock();          // a click is a valid user gesture to unlock audio
      setMusic(!musicEnabled);
    });
    reflectMusicState();

    /* Isolate our controls from the games' document/window-level pointer,
     * mouse, and touch handlers (many call preventDefault and would otherwise
     * hijack the native drag). Stop propagation ONLY — never preventDefault or
     * stopImmediatePropagation here, so the native range keeps its own default
     * drag behavior and its own input/change listeners keep firing. */
    function isolateEvents(el) {
      var types = ['pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove','touchstart','touchmove','touchend','click','dblclick','keydown','wheel'];
      for (var i = 0; i < types.length; i++) {
        el.addEventListener(types[i], function (e) { e.stopPropagation(); }, false);
      }
    }
    isolateEvents(volSlider);
    isolateEvents(btn);
    isolateEvents(musicBtn);

    document.body.appendChild(volSlider);
    document.body.appendChild(musicBtn);
    document.body.appendChild(btn);
  }

  function persistVolume() {
    try { localStorage.setItem(VOL_KEY, String(volume)); } catch (e) {}
  }

  /* ── Volume API ──────────────────────────────────────────── */
  function setVolume(v) {
    try {
      var nv = parseFloat(v);
      if (!isFinite(nv)) return;
      volume = Math.max(0, Math.min(1, nv));
      if (volSlider) volSlider.value = String(volume);
      persistVolume();
      applyMasterGain();
    } catch (e) { /* never throw */ }
  }
  function getVolume() { return volume; }

  function updateGlyph() {
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  }

  /* ── Mute state API ──────────────────────────────────────── */
  function isMuted() { return muted; }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    updateGlyph();
    applyMasterGain();   // drive the master gain down/up to match mute state
    /* Master mute silences the music too; unmuting resumes it if enabled. */
    if (muted) haltMusic(); else maybeStartMusic();
  }

  function toggleMute() { setMuted(!muted); }

  /* ── Auto-unlock on first user gesture (once each) ───────── */
  function autoUnlock() { unlock(); }
  document.addEventListener('pointerdown', autoUnlock, { once: true });
  document.addEventListener('keydown', autoUnlock, { once: true });

  /* ── Boot: inject button when DOM is ready ───────────────── */
  if (document.body) {
    injectButton();
  } else {
    document.addEventListener('DOMContentLoaded', injectButton, { once: true });
  }

  /* ── Expose global API (exactly this shape) ──────────────── */
  window.SFX = {
    unlock: unlock,
    isMuted: isMuted,
    setMuted: setMuted,
    toggleMute: toggleMute,
    play: play,
    startMusic: startMusic,
    stopMusic: stopMusic,
    setMusic: setMusic,
    isMusicOn: isMusicOn,
    setVolume: setVolume,
    getVolume: getVolume,
    /* Read-only: which background-music mood this page resolved to
     * (name + index). Handy for testing the per-game override map. */
    getMusicMood: function () {
      try { return { name: musicMood.name, index: musicMood.index }; }
      catch (e) { return null; }
    }
  };
})();
