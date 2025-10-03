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
    autoHashTracking: true,
    affinityHalfLifeMs: 1000 * 60 * 60 * 24 * 7 // 7 days
  };

  const DEFAULT_BUCKETS = {
    recipe: 'items',
    category: 'items',
    video: 'items',
    diet: 'items',
    search: 'items',
    section: 'items',
    action: 'items',
    tag: 'items',
    game: 'items',
    trailer: 'items'
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
  function round2(n){ return Math.round((Number(n)||0) * 100) / 100; }

  function createData(){
    return { version: DEFAULT_CONFIG.version, updatedAt: now(), buckets: {}, meta: {}, siteTitle: document.title || 'Unknown Site', sessionId: null };
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
        if (!obj.meta || typeof obj.meta !== 'object') obj.meta = {};
        
        // Check if site title has changed - if so, reset data
        const currentTitle = document.title || 'Unknown Site';
        if (obj.siteTitle && obj.siteTitle !== currentTitle) {
          console.log('InterestKit: Site title changed, resetting data');
          return createData();
        }
        
        // Ensure siteTitle is set
        if (!obj.siteTitle) obj.siteTitle = currentTitle;
        
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
    function setMeta(bucket, key, meta){
      if (!bucket || !key || !meta) return;
      const byBucket = (data.meta[bucket] || (data.meta[bucket] = {}));
      const current = byBucket[key] || {};
      byBucket[key] = Object.assign({}, current, meta);
      save();
    }
    function getMeta(bucket, key){
      const byBucket = data.meta[bucket] || {};
      return byBucket[key] || {};
    }
    function getTop(bucket, n){
      const map = data.buckets[bucket] || {};
      return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0, toNumber(n, 5));
    }
    function get(){ return data; }
    function exportJSON(){ return JSON.parse(JSON.stringify(data)); }
    function importJSON(obj){ if (obj && obj.buckets) { data = obj; save(); } }
    function reset(){ data = createData(); save(); }
    return { inc, getTop, set, setMeta, getMeta, get, exportJSON, importJSON, reset };
  }

  function debounce(fn, delay){ let t; return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this, args), delay); }; }

  const wired = new WeakSet();
  const debouncers = new WeakMap();
  let viewObserver = null;

  const InterestKit = {
    _config: Object.assign({}, DEFAULT_CONFIG),
    _storage: null,
    _engagementRetryCount: 0,
    _maxEngagementRetries: 10,
    _salesforceInitialized: false,
    _updateGlobalDataExposure(){
      try {
        const data = this._storage ? this._storage.get() : null;
        // Always expose data if storage exists, regardless of interaction count
        if (data) {
          global.INTEREST_KIT_DATA = data;
        } else {
          try { delete global.INTEREST_KIT_DATA; } catch(e) { global.INTEREST_KIT_DATA = undefined; }
        }
        this._trySetEngagement();
      } catch(e){}
    },
    _trySetEngagement(sendSalesforceEvents = false){
      try {
        if (global.agentforce_messaging && global.agentforce_messaging.util && typeof global.agentforce_messaging.util.setEngagement === 'function') {
          global.agentforce_messaging.util.setEngagement(global.INTEREST_KIT_DATA);
          this._engagementRetryCount = 0; // reset on success
          if (sendSalesforceEvents) {
            this._sendSalesforceInteractions();
          }
        } else if (this._engagementRetryCount < this._maxEngagementRetries) {
          // Retry after a delay
          this._engagementRetryCount++;
          setTimeout(() => this._trySetEngagement(sendSalesforceEvents), 500);
        }
      } catch(_) {}
    },
    _loadSalesforceScript(){
      if (global.document && !global.document.querySelector('script[src*="c360a.min.js"]')) {
        const script = global.document.createElement('script');
        script.src = 'https://cdn.pc-rnd.c360a.salesforce.com/beacon/c360a/7d4734d9-cd0b-406a-8850-94bea94a960b/scripts/c360a.min.js';
        script.onload = () => {
          setTimeout(() => {
            this._initSalesforceInteractions();
          }, 100);
        };
        global.document.head.appendChild(script);
      } else if (global.SalesforceInteractions) {
        this._initSalesforceInteractions();
      }
    },
    _initSalesforceInteractions(){
      try {
        if (global.SalesforceInteractions && !this._salesforceInitialized) {
          global.SalesforceInteractions.init({
            consents: [{
              provider: 'OneTrust',
              purpose: 'Tracking',
              status: global.SalesforceInteractions.ConsentStatus.OptIn
            }]
          }).then(() => {
            console.log('SalesforceInteractions init successful');
            this._salesforceInitialized = true;
            this._updateSessionId();
          }).catch((err) => {
            console.warn('SalesforceInteractions init failed:', err);
          });
        }
      } catch(_) {}
    },
    _sendNewEngagementEvent(bucket, key, weight, meta){
      try {
        if (!this._salesforceInitialized) {
          this._loadSalesforceScript();
          return;
        }
        
        if (global.SalesforceInteractions && typeof global.SalesforceInteractions.sendEvent === 'function') {
          global.SalesforceInteractions.setLoggingLevel(5);
          
          const affinity = this.getAffinity(bucket, key);
          const title = meta.title || key;
          const tags = [meta.genre, meta.category, meta.type].filter(Boolean).join(', ') || 'engagement';
          
          global.SalesforceInteractions.sendEvent({
            interaction: {
              name: "item",
              eventType: "item", 
              title: title,
              tags: tags,
              affinity: affinity
            },
            user: {
                identities: {
                  deviceId: "DEVICE-12345"
                }
             }
          });
        }
      } catch(_) {}
    },
    _updateSessionId(){
      try {
        if (global.SalesforceInteractions && typeof global.SalesforceInteractions.getAnonymousId === 'function') {
          const sessionId = global.SalesforceInteractions.getAnonymousId();
          if (sessionId && this._storage) {
            const data = this._storage.get();
            data.sessionId = sessionId;
            this._storage.get = () => data; // Update the stored data
            this._updateGlobalDataExposure();
            console.log('SessionId updated:', sessionId);
          }
        }
      } catch(_) {}
    },
    init(userConfig){
      if (this._storage) return this; // already initialized
      this._config = Object.assign({}, DEFAULT_CONFIG, userConfig || {});
      this._storage = InterestStorage(this._config.storageKey);
      // Expose data globally and call agentforce_messaging on init
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
    _collectMeta(el){
      const ds = el.dataset;
      const reserved = new Set(['track','trackType','trackId','trackBucket','trackWeight']);
      const meta = {};
      Object.keys(ds).forEach(k => {
        if (!k.startsWith('track')) return;
        if (reserved.has(k)) return;
        const prop = k.slice(5); // after 'track'
        if (!prop) return;
        const name = prop.charAt(0).toLowerCase() + prop.slice(1);
        const raw = ds[k];
        if (raw == null) return;
        // parse simple types
        if (/[|,]/.test(raw)) meta[name] = splitList(raw);
        else if (/^\d+(?:\.\d+)?$/.test(raw)) meta[name] = Number(raw);
        else if (raw === 'true' || raw === 'false') meta[name] = (raw === 'true');
        else meta[name] = raw;
      });
      return meta;
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

        // Record the main item and optional metadata
        const meta = this._collectMeta(el);
        meta.event = eventType; meta.type = type; meta.lastSeenAt = now();
        this.record({ bucket, key, weight, meta });

        // Interest score: count clicks per item
        if (eventType === 'click') {
          const prev = this._storage.getMeta(bucket, key) || {};
          const clicks = (prev.clicks || 0) + 1;
          this._storage.setMeta(bucket, key, { clicks, lastClickAt: now() });
          this._updateGlobalDataExposure();
          
          // Send new click events to Salesforce
          this._sendNewEngagementEvent(bucket, key, weight, meta);
        }

        // Affinity score: exponential time-decayed weight accumulation
        this._updateAffinity(bucket, key, weight);

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
    record({ bucket, key, weight = 1, meta }){
      if (!this._storage) this.init();
      this._storage.inc(bucket, key, weight);
      if (meta && typeof meta === 'object') this._storage.setMeta(bucket, key, meta);
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
    data(){ return this._storage ? this._storage.get() : createData(); },
    getClickCount(bucket, key){ if (!this._storage) this.init(); const m=this._storage.getMeta(bucket,key)||{}; return m.clicks||0; },
    getTopByClicks(bucket, n=5){ if(!this._storage) this.init(); const data=this._storage.get(); const byBucket=(data.meta[bucket]||{}); return Object.entries(byBucket).map(([k,v])=>[k, v.clicks||0]).sort((a,b)=>b[1]-a[1]).slice(0,n); },
    // Affinity helpers
    _decayValue(current, lastTs, nowTs){
      const halfLife = this._config.affinityHalfLifeMs;
      if (!current || !lastTs) return current || 0;
      const lambda = Math.LN2 / halfLife; // per ms
      const dt = Math.max(0, nowTs - lastTs);
      return current * Math.exp(-lambda * dt);
    },
    _updateAffinity(bucket, key, delta){
      if (!this._storage) this.init();
      const t = now();
      const meta = this._storage.getMeta(bucket, key) || {};
      const prevAffinity = meta.affinity || 0;
      const decayed = this._decayValue(prevAffinity, meta.affinityUpdatedAt || meta.lastSeenAt || t, t);
      const affinity = round2(decayed + (Number(delta) || 0));
      this._storage.setMeta(bucket, key, { affinity, affinityUpdatedAt: t });
      this._updateGlobalDataExposure();
      return affinity;
    },
    getAffinity(bucket, key){ if (!this._storage) this.init(); const m=this._storage.getMeta(bucket,key)||{}; return round2(this._decayValue(m.affinity||0, m.affinityUpdatedAt||m.lastSeenAt||now(), now())); },
    getTopByAffinity(bucket, n=5){ if(!this._storage) this.init(); const data=this._storage.get(); const byBucket=(data.meta[bucket]||{}); const t=now(); const entries=Object.entries(byBucket).map(([k,m])=>{ const v=this._decayValue(m.affinity||0, m.affinityUpdatedAt||m.lastSeenAt||t, t); return [k, round2(v)]; }); return entries.sort((a,b)=>b[1]-a[1]).slice(0,n); },
    getTopItems(n=5){ if(!this._storage) this.init(); const data=this._storage.get(); const itemsMeta=(data.meta||{}).items||{}; const t=now(); const entries=[]; Object.entries(itemsMeta).forEach(([k,m])=>{ const affinity=this._decayValue(m.affinity||0, m.affinityUpdatedAt||m.lastSeenAt||t, t); const lastSeen=m.lastSeenAt||m.affinityUpdatedAt||0; entries.push({key:k,affinity:round2(affinity),lastSeenAt:lastSeen,meta:m}); }); return entries.sort((a,b)=>{ const diff=b.affinity-a.affinity; if(diff!==0)return diff; return b.lastSeenAt-a.lastSeenAt; }).slice(0,n); }
  };

  // Attach globally
  global.InterestKit = InterestKit;
  // Auto-init in browsers
  try { InterestKit.init(); } catch(e){}

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));


