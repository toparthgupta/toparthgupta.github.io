(function(global){
  'use strict';

  // InterestKit: Attribute-driven interest tracking for any website
  // Usage: add data attributes to elements and include this script.
  // Example:
  //   <article data-track="click view" data-track-type="recipe" data-track-id="pumpkin-soup" data-track-category="Soups" data-track-tags="Fall,One‑Pot"></article>
  //   <input data-track="input" data-track-type="search" placeholder="Search">  
  //   <select data-track="change" data-track-type="diet">...</select>

  const DEFAULT_CONFIG = {
    storageKey: 'interestkit:data',
    version: 1,
    observeMutations: true,
    observeViews: false,
    viewThreshold: 0.4,
    debounceMs: 400,
    attributePrefix: 'track', // dataset prefix: dataset.track*, i.e., data-track-*
    tokenStopWords: new Set(['the','and','for','with','to','of','a','in','on','by','or','at','is','it','how','make','your','you','from']),
    autoHashTracking: true
  };

  const DEFAULT_BUCKETS = {
    recipe: 'recipes',
    category: 'categories',
    video: 'videos',
    diet: 'diets',
    search: 'searchTerms',
    section: 'sections',
    action: 'actions',
    tag: 'tags'
  };

  function now(){ return Date.now(); }
  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
  function toNumber(n, fallback){ const x = Number(n); return Number.isFinite(x) ? x : (fallback ?? 1); }
  function splitList(str){ return String(str || '').split(/[|,]/).map(s=>s.trim()).filter(Boolean); }
  function tokenize(value, stop){
    return String(value || '').toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t && t.length > 1 && !stop.has(t));
  }

  function createData(){
    return { version: DEFAULT_CONFIG.version, updatedAt: now(), buckets: {} };
  }

  function InterestStorage(storageKey){
    let data = load();
    function load(){
      try {
        const raw = global.localStorage.getItem(storageKey);
        if (!raw) return createData();
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return createData();
        if (!obj.buckets || typeof obj.buckets !== 'object') obj.buckets = {};
        return obj;
      } catch(e){ return createData(); }
    }
    function save(){ data.updatedAt = now(); try { global.localStorage.setItem(storageKey, JSON.stringify(data)); } catch(e){} }
    function inc(bucket, key, weight){
      if (!bucket || !key) return;
      const w = toNumber(weight, 1);
      const buckets = data.buckets;
      const map = (buckets[bucket] || (buckets[bucket] = {}));
      map[key] = (map[key] || 0) + w;
      save();
    }
    function set(bucket, key, value){
      if (!bucket || !key) return;
      const buckets = data.buckets;
      const map = (buckets[bucket] || (buckets[bucket] = {}));
      map[key] = value;
      save();
    }
    function getTop(bucket, n){
      const map = data.buckets[bucket] || {};
      return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0, toNumber(n, 5));
    }
    function get(){ return data; }
    function exportJSON(){ return JSON.parse(JSON.stringify(data)); }
    function importJSON(obj){ if (obj && obj.buckets) { data = obj; save(); } }
    function reset(){ data = createData(); save(); }
    return { inc, getTop, set, get, exportJSON, importJSON, reset };
  }

  function debounce(fn, delay){ let t; return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this, args), delay); }; }

  const wired = new WeakSet();
  const debouncers = new WeakMap();
  let viewObserver = null;

  const InterestKit = {
    _config: Object.assign({}, DEFAULT_CONFIG),
    _storage: null,
    _updateGlobalDataExposure(){
      try {
        const data = this._storage ? this._storage.get() : null;
        const has = !!(data && data.buckets && Object.values(data.buckets).some(b => Object.keys(b || {}).length > 0));
        if (has) {
          global.INTEREST_KIT_DATA = data;
        } else {
          try { delete global.INTEREST_KIT_DATA; } catch(e) { global.INTEREST_KIT_DATA = undefined; }
        }
      } catch(e){}
    },
    init(userConfig){
      if (this._storage) return this; // already initialized
      this._config = Object.assign({}, DEFAULT_CONFIG, userConfig || {});
      this._storage = InterestStorage(this._config.storageKey);
      // Do not expose data globally until first recorded interaction
      this._updateGlobalDataExposure();
      // Observers
      if (this._config.observeViews && 'IntersectionObserver' in global) {
        viewObserver = new IntersectionObserver(this._onView.bind(this), { threshold: clamp(this._config.viewThreshold, 0.1, 1) });
      }
      if (this._config.observeMutations && 'MutationObserver' in global) {
        const mo = new MutationObserver((muts)=>{
          muts.forEach(m => {
            m.addedNodes && m.addedNodes.forEach(node => { if (node.nodeType === 1) this.scan(node); });
          });
        });
        mo.observe(document.documentElement, { subtree: true, childList: true });
      }
      if (this._config.autoHashTracking) {
        global.addEventListener('hashchange', ()=>{
          const id = (global.location.hash || '').slice(1);
          if (id) this.record({ bucket: DEFAULT_BUCKETS.section, key: id, weight: 1, meta: { event: 'hashchange' } });
        });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ()=> this.scan(document));
      } else {
        this.scan(document);
      }
      return this;
    },
    scan(root){
      const scope = root || document;
      const nodes = scope.querySelectorAll('[data-track]');
      nodes.forEach(el => this._wire(el));
      return nodes.length;
    },
    _wire(el){
      if (wired.has(el)) return;
      const ds = el.dataset;
      const types = String(ds.track || 'click').toLowerCase().split(/[\s,]+/).filter(Boolean);
      const shouldObserveView = types.includes('view') && viewObserver;
      // Assign listeners based on declared events
      if (types.includes('click')) el.addEventListener('click', (e) => this._handleEvent(el, 'click', e));
      if (types.includes('hover')) el.addEventListener('mouseenter', (e) => this._handleEvent(el, 'hover', e));
      if (types.includes('change')) el.addEventListener('change', (e) => this._handleEvent(el, 'change', e));
      if (types.includes('submit') && el.tagName === 'FORM') el.addEventListener('submit', (e) => this._handleEvent(el, 'submit', e));
      if (types.includes('input')) {
        const conf = this._config;
        const deb = debounce((e)=> this._handleEvent(el, 'input', e), conf.debounceMs);
        debouncers.set(el, deb);
        el.addEventListener('input', (e)=> deb(e));
      }
      if (shouldObserveView) viewObserver.observe(el);
      wired.add(el);
    },
    _onView(entries){
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          viewObserver.unobserve(el);
          this._handleEvent(el, 'view', null);
        }
      });
    },
    _handleEvent(el, eventType, rawEvent){
      try {
        const ds = el.dataset;
        const type = (ds.trackType || '').toLowerCase();
        const bucket = ds.trackBucket || (DEFAULT_BUCKETS[type] || 'actions');
        const weight = toNumber(ds.trackWeight, this._defaultWeightFor(eventType, type));
        // Determine key/label
        let key = ds.trackId || ds.trackLabel || '';
        if (!key) {
          if (type === 'section') key = (el.getAttribute('href') || '').replace(/^#/, '') || el.id || el.name || 'section';
          else if (el.value && (eventType === 'change' || eventType === 'input')) key = String(el.value).trim();
          else key = (el.textContent || '').trim().slice(0, 64) || (el.id || el.className || 'item');
        }

        // Special handling for search inputs
        if (type === 'search') {
          this.recordSearch(el.value, weight);
          return;
        }

        // Record the main item
        this.record({ bucket, key, weight, meta: { event: eventType, type } });

        // Optional linked fields
        if (ds.trackCategory) this.record({ bucket: DEFAULT_BUCKETS.category, key: ds.trackCategory, weight: 1, meta: { via: type } });
        if (ds.trackTags) splitList(ds.trackTags).forEach(t => this.record({ bucket: DEFAULT_BUCKETS.tag, key: t, weight: 1, meta: { via: type } }));

      } catch(err) {
        // Silent by default
      }
    },
    _defaultWeightFor(eventType, type){
      if (type === 'recipe' && eventType === 'click') return 3;
      if (type === 'recipe' && eventType === 'view') return 2;
      if (type === 'video' && eventType === 'click') return 2;
      if (eventType === 'input') return 0.5;
      return 1;
    },
    // Public API
    record({ bucket, key, weight = 1 /*, meta */ }){
      if (!this._storage) this.init();
      this._storage.inc(bucket, key, weight);
      this._updateGlobalDataExposure();
    },
    recordTokens(bucket, value, weight = 1){
      if (!this._storage) this.init();
      tokenize(value, this._config.tokenStopWords).forEach(tok => this._storage.inc(bucket, tok, weight));
      this._updateGlobalDataExposure();
    },
    recordSearch(query, weight = 1){
      this.recordTokens(DEFAULT_BUCKETS.search, query, weight);
    },
    getTop(bucket, n){
      if (!this._storage) this.init();
      return this._storage.getTop(bucket, n);
    },
    export(){ return this._storage ? this._storage.exportJSON() : createData(); },
    import(obj){ if (!this._storage) this.init(); this._storage.importJSON(obj); this._updateGlobalDataExposure(); },
    reset(){ if (!this._storage) this.init(); this._storage.reset(); this._updateGlobalDataExposure(); },
    data(){ return this._storage ? this._storage.get() : createData(); }
  };

  // Attach globally
  global.InterestKit = InterestKit;
  // Auto-init in browsers
  try { InterestKit.init(); } catch(e){}

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));


