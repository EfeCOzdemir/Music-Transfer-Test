/* Music Transfer Test — transfers playlists between Spotify, YouTube Music and Apple Music.
 * Runs fully in the browser: Spotify via OAuth PKCE redirect, YouTube via Google OAuth redirect,
 * Apple Music via MusicKit JS.
 */
'use strict';

const $ = (s) => document.querySelector(s);
// Same value whether the page was opened as /path/ or /path/index.html, so it matches the registered URI
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const LIKED_ID = '__liked';

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  rows: [],          // { src, match, score, checked, pending, already, done }
  stop: false,
  busy: false,
};

/* ---------------- UI helpers ---------------- */

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 7000 : 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fromId = () => $('#fromService').value;
const toId = () => $('#toService').value;

/* ---------------- Settings ---------------- */

function cfg() {
  // config.js defaults, overridden by anything typed into Settings on this device
  const out = { spotifyClientId: '', googleClientId: '', appleDevToken: '', ...(window.APP_CONFIG || {}) };
  for (const [k, v] of Object.entries(store.get('cfg', {}))) if (v) out[k] = v;
  return out;
}

function openSettings() {
  const c = cfg();
  $('#spClientId').value = c.spotifyClientId;
  $('#ggClientId').value = c.googleClientId;
  $('#amDevToken').value = c.appleDevToken;
  $('#settings').showModal();
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign an Apple Music developer token (ES256 JWT) from a .p8 key, entirely in the browser. */
async function generateAppleToken(teamId, keyId, p8) {
  const der = Uint8Array.from(atob(p8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const input = enc({ alg: 'ES256', kid: keyId }) + '.' + enc({ iss: teamId, iat: now, exp: now + 180 * 24 * 3600 });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return input + '.' + b64url(sig);
}

/* ================================================================
 * Song parsing & matching (shared by all services)
 * ================================================================ */

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(s) { return new Set(norm(s).split(' ').filter(Boolean)); }

function sim(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const JUNK = /\s*[\(\[][^\)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v|clip|music video|explicit|color coded|remaster(ed)?)\b[^\)\]]*[\)\]]/gi;

function cleanTitle(t) {
  return String(t)
    .replace(JUNK, '')
    .replace(/\s+-\s+[^-]*\bremaster(ed)?\b.*$/i, '') // Spotify style "Song - Remastered 2011"
    .replace(/\s*[\(\[]?\s*\b(feat\.?|ft\.?|featuring)\s[^\)\]]*[\)\]]?/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+/g, ' ').trim();
}

function mainArtist(a) {
  return String(a).split(/\s*(?:,|;|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*/i)[0].trim();
}

/** Turn a YouTube video title + channel into { title, artist }. */
function parseYt(title, channel) {
  channel = String(channel || '');
  const isTopic = /\s-\s*Topic$/i.test(channel);
  let artist = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*official$/i, '').trim();
  let t = String(title || '');
  if (!isTopic) {
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) { artist = m[1]; t = m[2]; }
  }
  return { title: cleanTitle(t), artist: mainArtist(artist) };
}

function scoreMatch(src, cand) {
  const titleScore = Math.max(sim(src.title, cand.title), sim(cleanTitle(src.title), cleanTitle(cand.title)));
  const artistScore = Math.max(sim(src.artist, cand.artist), sim(mainArtist(src.artist), mainArtist(cand.artist)));
  return 0.65 * titleScore + 0.35 * artistScore;
}

/** Keep the best-scoring candidate. An exact ISRC hit is the same recording, so it's trusted. */
function pickBest(best, src, cand, bonus = 0) {
  let score = Math.min(1, scoreMatch(src, cand) + bonus);
  if (src.isrc && cand.isrc && src.isrc.toUpperCase() === cand.isrc.toUpperCase()) score = Math.max(score, 0.95);
  return !best || score > best.score ? { match: cand, score } : best;
}

function confLabel(score) {
  if (score >= 0.75) return ['high', 'Good'];
  if (score >= 0.5) return ['mid', 'Check'];
  return ['low', 'Unsure'];
}

function searchTerm(src) { return `${mainArtist(src.artist)} ${cleanTitle(src.title)}`.trim(); }

/* ================================================================
 * Spotify
 * ================================================================ */

const SP_SCOPES = [
  'playlist-read-private', 'playlist-read-collaborative',
  'playlist-modify-private', 'playlist-modify-public', 'user-library-read',
].join(' ');

async function spotifyLogin() {
  const clientId = cfg().spotifyClientId;
  if (!clientId) return openSettings();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('sp_verifier', verifier);
  sessionStorage.setItem('sp_state', st);
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SP_SCOPES, state: st,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
  return 'redirect';
}

async function spotifyTokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg().spotifyClientId, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Spotify login failed: ' + (data.error_description || data.error));
  const prev = store.get('sp_token', {});
  store.set('sp_token', {
    access: data.access_token,
    refresh: data.refresh_token || prev.refresh,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  });
}

async function handleSpotifyCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', location.pathname);
  if (q.get('error')) return toast('Spotify login cancelled: ' + q.get('error'), true);
  if (q.get('state') !== sessionStorage.getItem('sp_state')) return toast('Spotify login state mismatch, try again.', true);
  await spotifyTokenRequest({
    grant_type: 'authorization_code', code: q.get('code'),
    redirect_uri: REDIRECT_URI, code_verifier: sessionStorage.getItem('sp_verifier'),
  });
  sessionStorage.removeItem('sp_verifier');
  sessionStorage.removeItem('sp_state');
}

async function spToken() {
  const t = store.get('sp_token');
  if (!t) throw new Error('Spotify is not connected');
  if (Date.now() < t.expires) return t.access;
  if (!t.refresh) throw new Error('Spotify session expired, reconnect');
  await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  return store.get('sp_token').access;
}

async function sp(path, opts = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + (await spToken()), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000);
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error('Spotify: ' + (data.error?.message || res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Spotify: rate limited, try again later');
}

// Spotify renamed some playlist endpoints in 2026 (/tracks → /items, /users/{id}/playlists → /me/playlists).
// Try the new one and fall back to the old one.
async function spWithFallback(newPath, oldPath, opts) {
  try { return await sp(newPath, opts); }
  catch (e) { if ([403, 404, 405].includes(e.status)) return sp(oldPath, opts); throw e; }
}

function spTrack(t) {
  return {
    title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '),
    key: t.uri, uri: t.uri, url: t.external_urls?.spotify, isrc: t.external_ids?.isrc,
  };
}

const spotify = {
  name: 'Spotify',
  user: null,
  playlists: [],

  hasConfig: () => !!cfg().spotifyClientId,
  connect: spotifyLogin,
  disconnect() { store.del('sp_token'); this.user = null; this.playlists = []; },

  async restore() {
    if (!store.get('sp_token') || this.user) return;
    try {
      this.user = await sp('/me');
      this.playlists = [{ id: LIKED_ID, name: '❤ Liked Songs', count: '' }];
      let url = '/me/playlists?limit=50';
      while (url) {
        const d = await sp(url);
        for (const p of d.items) {
          if (p) this.playlists.push({ id: p.id, name: p.name, count: p.items?.total ?? p.tracks?.total ?? '', editable: p.owner?.id === this.user.id });
        }
        url = d.next;
      }
    } catch (e) {
      toast(e.message, true);
      if (e.status === 401 || e.status === 400) store.del('sp_token');
    }
  },
  status() { return this.user ? `Connected as ${this.user.display_name || this.user.id}` : null; },

  async readTracks(id) {
    const out = [];
    let url = id === LIKED_ID ? '/me/tracks?limit=50' : null;
    if (!url) {
      // pick whichever endpoint works for this account
      try { await sp(`/playlists/${id}/items?limit=1`); url = `/playlists/${id}/items?limit=50`; }
      catch (e) { if ([403, 404, 405].includes(e.status)) url = `/playlists/${id}/tracks?limit=50`; else throw e; }
    }
    while (url) {
      const d = await sp(url);
      for (const it of d.items) {
        const t = it.item || it.track;
        if (t && t.type === 'track' && !t.is_local) out.push(spTrack(t));
      }
      url = d.next;
    }
    return out;
  },

  async search(src) {
    const queries = [];
    if (src.isrc) queries.push(`isrc:${src.isrc}`);
    if (src.artist) queries.push(`track:${src.title} artist:${mainArtist(src.artist)}`);
    queries.push(searchTerm(src));
    if (src.rawTitle && src.rawTitle !== src.title) queries.push(cleanTitle(src.rawTitle));
    let best = null;
    for (const q of queries) {
      const d = await sp(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
      for (const t of d.tracks?.items || []) best = pickBest(best, src, spTrack(t));
      if (best && best.score >= 0.75) break;
    }
    return best || { match: null, score: 0 };
  },

  async createPlaylist(name, fromName) {
    const body = JSON.stringify({ name, public: false, description: `Transferred from ${fromName}` });
    const p = await spWithFallback('/me/playlists', `/users/${encodeURIComponent(this.user.id)}/playlists`, { method: 'POST', body });
    this.playlists.push({ id: p.id, name: p.name, count: 0, editable: true });
    return p.id;
  },

  async addTracks(id, rows, onAdded) {
    for (let i = 0; i < rows.length && !state.stop; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const body = JSON.stringify({ uris: chunk.map((r) => r.match.uri) });
      await spWithFallback(`/playlists/${id}/items`, `/playlists/${id}/tracks`, { method: 'POST', body });
      onAdded(chunk);
    }
  },

  playlistUrl: (id) => 'https://open.spotify.com/playlist/' + id,
};

/* ================================================================
 * YouTube Music (YouTube Data API v3)
 * ================================================================ */

// Google sign-in as a full-page redirect (like Spotify), which also works well on phones
function googleLogin() {
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('yt_state', st);
  const p = new URLSearchParams({
    client_id: cfg().googleClientId, redirect_uri: REDIRECT_URI, response_type: 'token',
    scope: 'https://www.googleapis.com/auth/youtube', state: st, include_granted_scopes: 'true',
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  return 'redirect';
}

function handleGoogleCallback() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (!q.has('access_token') && !q.has('error')) return;
  history.replaceState(null, '', location.pathname);
  if (q.get('error')) return toast('YouTube login cancelled: ' + q.get('error'), true);
  if (q.get('state') !== sessionStorage.getItem('yt_state')) return toast('YouTube login state mismatch, try again.', true);
  sessionStorage.removeItem('yt_state');
  store.set('yt_token', { access: q.get('access_token'), expires: Date.now() + (Number(q.get('expires_in')) - 60) * 1000 });
}

async function ytToken() {
  const t = store.get('yt_token');
  if (t && Date.now() < t.expires) return t.access;
  store.del('yt_token');
  youtube.channel = null;
  throw new Error('YouTube sign-in expired (it lasts 1 hour). Click Connect again.');
}

class QuotaError extends Error {}

async function yt(path, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://www.googleapis.com/youtube/v3/' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + (await ytToken()), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const reason = data.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new QuotaError('YouTube daily API quota used up. It resets at midnight Pacific time — run again then (progress is remembered).');
    }
    if (res.status === 401) { store.del('yt_token'); continue; }
    if (res.status === 409 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error('YouTube: ' + (data.error?.message || res.status));
  }
  throw new Error('YouTube: request kept failing, try again later');
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

const youtube = {
  name: 'YouTube Music',
  channel: null,
  playlists: [],

  hasConfig: () => !!cfg().googleClientId,
  connect: googleLogin,

  disconnect() {
    const t = store.get('yt_token');
    if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.access), { method: 'POST', mode: 'no-cors' }).catch(() => {});
    store.del('yt_token');
    this.channel = null; this.playlists = [];
  },

  async restore() {
    const t = store.get('yt_token');
    if (!this.channel && t && Date.now() < t.expires) await this.load();
  },

  async load() {
    try {
      const ch = await yt('channels?part=snippet&mine=true');
      this.channel = ch.items?.[0]?.snippet?.title || 'your Google account';
      const out = [];
      let token = '';
      do {
        const d = await yt(`playlists?part=snippet,contentDetails&mine=true&maxResults=50${token ? '&pageToken=' + token : ''}`);
        for (const p of d.items || []) out.push({ id: p.id, name: p.snippet.title, count: p.contentDetails.itemCount, editable: true });
        token = d.nextPageToken;
      } while (token);
      this.playlists = out;
    } catch (e) {
      toast(e.message, true);
    }
  },
  status() { return this.channel ? `Connected as ${this.channel}` : null; },

  async readTracks(id) {
    const out = [];
    let token = '';
    do {
      const d = await yt(`playlistItems?part=snippet&playlistId=${encodeURIComponent(id)}&maxResults=50${token ? '&pageToken=' + token : ''}`);
      for (const it of d.items || []) {
        const s = it.snippet;
        if (!s?.resourceId?.videoId || /^(Deleted|Private) video$/i.test(s.title)) continue;
        const v = s.resourceId.videoId;
        out.push({ ...parseYt(s.title, s.videoOwnerChannelTitle), rawTitle: s.title, key: v, videoId: v, url: 'https://music.youtube.com/watch?v=' + v });
      }
      token = d.nextPageToken;
    } while (token);
    return out;
  },

  async search(src) {
    const d = await yt(`search?part=snippet&type=video&videoCategoryId=10&maxResults=5&q=${encodeURIComponent(searchTerm(src))}`);
    let best = null;
    (d.items || []).forEach((it, i) => {
      const v = it.id.videoId;
      const cand = { ...parseYt(decodeEntities(it.snippet.title), decodeEntities(it.snippet.channelTitle)), key: v, videoId: v, url: 'https://music.youtube.com/watch?v=' + v };
      // small bonus for official "Artist - Topic" audio uploads and for ranking higher
      const topic = /\s-\s*Topic$/i.test(it.snippet.channelTitle) ? 0.05 : 0;
      best = pickBest(best, src, cand, topic - i * 0.01);
    });
    return best || { match: null, score: 0 };
  },

  async createPlaylist(name, fromName) {
    const p = await yt('playlists?part=snippet,status', {
      method: 'POST',
      body: JSON.stringify({ snippet: { title: name, description: `Transferred from ${fromName}` }, status: { privacyStatus: 'private' } }),
    });
    this.playlists.push({ id: p.id, name, count: 0, editable: true });
    return p.id;
  },

  async addTracks(id, rows, onAdded) {
    for (const r of rows) {
      if (state.stop) break;
      await yt('playlistItems?part=snippet', {
        method: 'POST',
        body: JSON.stringify({ snippet: { playlistId: id, resourceId: { kind: 'youtube#video', videoId: r.match.videoId } } }),
      });
      onAdded([r]);
    }
  },

  playlistUrl: (id) => 'https://music.youtube.com/playlist?list=' + id,

  quotaHint(count) {
    const units = count * 150 + 50;
    return {
      text: `YouTube's free API quota is 10,000 units/day; this playlist needs ~${units.toLocaleString()} (searching costs 100, adding 50 per song). ` +
        (units > 10000 ? 'Large playlists will take several days — re-run and choose "Add to" the same playlist to continue.' : ''),
      warn: units > 10000,
    };
  },
};

/* ================================================================
 * Apple Music (MusicKit JS + Apple Music API)
 * ================================================================ */

let amConfigured = null;

function amConfigure() {
  if (amConfigured) return amConfigured;
  const developerToken = cfg().appleDevToken;
  if (!developerToken) return Promise.reject(new Error('Add an Apple Music developer token in Settings'));
  if (!window.MusicKit) return Promise.reject(new Error('Apple MusicKit is still loading, try again in a second'));
  amConfigured = Promise.resolve(MusicKit.configure({ developerToken, app: { name: 'Music Transfer Test', build: '1.0.0' } }))
    .then(() => MusicKit.getInstance())
    .catch((e) => { amConfigured = null; throw new Error('Apple Music setup failed: ' + (e.message || e)); });
  return amConfigured;
}

async function am(path, opts = {}) {
  const url = 'https://api.music.apple.com' + (path.startsWith('/v1') ? path : '/v1' + path);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + cfg().appleDevToken,
        'Music-User-Token': store.get('am_user_token') || '',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000); continue; }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error('Apple Music: ' + (data.errors?.[0]?.detail || data.errors?.[0]?.title || res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Apple Music: rate limited, try again later');
}

function amSong(s) {
  const a = s.attributes || {};
  return { title: a.name, artist: a.artistName, key: s.id, id: s.id, isrc: a.isrc, url: a.url };
}

const apple = {
  name: 'Apple Music',
  storefront: null,
  playlists: [],

  hasConfig: () => !!cfg().appleDevToken,

  async connect() {
    try {
      const music = await amConfigure();
      const token = await music.authorize();
      if (!token) throw new Error('Apple Music login was cancelled');
      store.set('am_user_token', token);
    } catch (e) {
      return toast(e.message || String(e), true);
    }
    await this.load();
  },

  disconnect() {
    amConfigure().then((m) => m.unauthorize()).catch(() => {});
    store.del('am_user_token');
    this.storefront = null; this.playlists = [];
  },

  async restore() {
    if (!this.storefront && store.get('am_user_token') && cfg().appleDevToken) await this.load();
  },

  async load() {
    try {
      const sf = await am('/me/storefront');
      this.storefront = sf.data?.[0]?.id || 'us';
      const out = [];
      let url = '/me/library/playlists?limit=100';
      while (url) {
        const d = await am(url);
        for (const p of d.data || []) out.push({ id: p.id, name: p.attributes?.name || 'Untitled', count: '', editable: !!p.attributes?.canEdit });
        url = d.next;
      }
      this.playlists = out;
    } catch (e) {
      toast(e.status === 401 || e.status === 403 ? 'Apple Music session expired or no active subscription — reconnect.' : e.message, true);
      if (e.status === 401 || e.status === 403) store.del('am_user_token');
      this.storefront = null;
    }
  },
  status() { return this.storefront ? `Connected (${this.storefront.toUpperCase()} store)` : null; },

  async readTracks(id) {
    const out = [];
    let url = `/me/library/playlists/${id}/tracks?limit=100`;
    while (url) {
      let d;
      try { d = await am(url); }
      catch (e) { if (e.status === 404) break; throw e; } // empty playlists return 404
      for (const t of d.data || []) {
        const a = t.attributes || {};
        const pp = a.playParams || {};
        const catalogId = pp.catalogId || (!pp.isLibrary ? pp.id : null);
        out.push({ title: a.name, artist: a.artistName, key: catalogId || t.id, catalogId, url: a.url });
      }
      url = d.next;
    }
    // Library tracks don't carry ISRCs; fetch them from the catalog for exact matching elsewhere.
    const ids = [...new Set(out.map((t) => t.catalogId).filter(Boolean))];
    const info = {};
    for (let i = 0; i < ids.length; i += 300) {
      try {
        const d = await am(`/catalog/${this.storefront}/songs?ids=${ids.slice(i, i + 300).join(',')}`);
        for (const s of d.data || []) info[s.id] = s.attributes || {};
      } catch { /* ISRCs are a nice-to-have */ }
    }
    for (const t of out) {
      const a = info[t.catalogId];
      if (a) { t.isrc = a.isrc; t.url = t.url || a.url; }
    }
    return out;
  },

  async search(src) {
    let best = null;
    if (src.isrc) {
      const d = await am(`/catalog/${this.storefront}/songs?filter[isrc]=${encodeURIComponent(src.isrc)}`);
      for (const s of d.data || []) best = pickBest(best, src, amSong(s));
    }
    if (!best || best.score < 0.75) {
      const d = await am(`/catalog/${this.storefront}/search?types=songs&limit=5&term=${encodeURIComponent(searchTerm(src))}`);
      for (const s of d.results?.songs?.data || []) best = pickBest(best, src, amSong(s));
    }
    return best || { match: null, score: 0 };
  },

  async createPlaylist(name, fromName) {
    const d = await am('/me/library/playlists', {
      method: 'POST',
      body: JSON.stringify({ attributes: { name, description: `Transferred from ${fromName}` } }),
    });
    const id = d.data[0].id;
    this.playlists.push({ id, name, count: 0, editable: true });
    return id;
  },

  async addTracks(id, rows, onAdded) {
    for (let i = 0; i < rows.length && !state.stop; i += 100) {
      const chunk = rows.slice(i, i + 100);
      await am(`/me/library/playlists/${id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ data: chunk.map((r) => ({ id: r.match.id, type: 'songs' })) }),
      });
      onAdded(chunk);
    }
  },

  // Library playlist ids (p.xxx) open in the web player's library view
  playlistUrl: (id) => 'https://music.apple.com/library/playlist/' + id,
};

const services = { spotify, youtube, apple };

/* ================================================================
 * Rendering
 * ================================================================ */

function renderAccounts() {
  for (const [id, svc] of Object.entries(services)) {
    const status = svc.status();
    $(`#${id}Status`).textContent = status || 'Not connected';
    $(`#${id}Status`).classList.toggle('on', !!status);
    $(`#${id}Connect`).hidden = !!status;
    $(`#${id}Logout`).hidden = !status;
  }
  $('#setupHint').hidden = Object.values(services).filter((s) => s.hasConfig()).length >= 2;
}

function renderPlaylists() {
  const from = services[fromId()], to = services[toId()];
  const ready = !!(from.status() && to.status());
  const sSel = $('#sourceSelect'), dSel = $('#destSelect');
  if (!ready) {
    const missing = [from, to].filter((s) => !s.status()).map((s) => s.name).join(' and ');
    sSel.innerHTML = `<option>Connect ${esc(missing)} first</option>`;
    dSel.innerHTML = '<option value="__new">New playlist</option>';
    sSel.disabled = dSel.disabled = true;
    $('#matchBtn').disabled = true;
    $('#quotaHint').textContent = '';
    return;
  }
  sSel.innerHTML = from.playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.count !== '' ? ` (${p.count})` : ''}</option>`).join('')
    || '<option value="">No playlists found</option>';
  dSel.innerHTML = '<option value="__new">➕ New playlist</option>' +
    to.playlists.filter((p) => p.editable && p.id !== LIKED_ID).map((p) => `<option value="${esc(p.id)}">Add to: ${esc(p.name)}</option>`).join('');
  sSel.disabled = dSel.disabled = state.busy;
  $('#matchBtn').disabled = state.busy || !from.playlists.length;
  updateDestFields();
}

function updateDestFields() {
  $('#newNameField').hidden = $('#destSelect').value !== '__new';
  const sel = $('#sourceSelect').selectedOptions[0];
  $('#newName').placeholder = sel ? sel.textContent.replace(/\s\(\d+\)$/, '') : 'Same as source';
  const pl = services[fromId()].playlists.find((p) => p.id === $('#sourceSelect').value);
  const hint = $('#quotaHint');
  const q = pl && pl.count && services[toId()].quotaHint?.(pl.count);
  hint.textContent = q ? q.text : '';
  hint.className = 'hint' + (q && q.warn ? ' warn' : '');
}

function renderRows() {
  $('#matchTable tbody').innerHTML = state.rows.map((r, i) => {
    const s = r.src;
    const srcHtml = `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="t">${esc(s.title)}</a><div class="a">${esc(s.artist)}</div>`;
    let matchHtml, conf;
    if (r.pending) { matchHtml = '<span class="a">searching…</span>'; conf = '<span class="conf skip">…</span>'; }
    else if (r.already) { matchHtml = '<span class="a">already in destination</span>'; conf = '<span class="conf skip">Skip</span>'; }
    else if (!r.match) { matchHtml = 'Not found'; conf = '<span class="conf low">None</span>'; }
    else {
      const [cls, label] = confLabel(r.score);
      matchHtml = `<a href="${esc(r.match.url)}" target="_blank" rel="noopener" class="t">${esc(r.match.title)}</a><div class="a">${esc(r.match.artist)}</div>`;
      conf = `<span class="conf ${cls}" title="${Math.round(r.score * 100)}%">${label}</span>`;
    }
    const box = r.match && !r.already && !r.pending
      ? `<input type="checkbox" data-i="${i}" ${r.checked ? 'checked' : ''} aria-label="Include">`
      : '';
    return `<tr><td>${r.done ? '✓' : box}</td><td>${srcHtml}</td><td class="${!r.match && !r.pending && !r.already ? 'none' : ''}">${matchHtml}</td><td>${conf}</td></tr>`;
  }).join('');
  renderSummary();
}

function renderSummary() {
  const rows = state.rows;
  const found = rows.filter((r) => r.match && !r.already).length;
  const sel = rows.filter((r) => r.checked && r.match && !r.already && !r.done).length;
  const miss = rows.filter((r) => !r.match && !r.pending && !r.already).length;
  const already = rows.filter((r) => r.already).length;
  $('#summary').innerHTML =
    `<span class="pill">${rows.length} songs</span><span class="pill">${found} matched</span>` +
    (miss ? `<span class="pill">${miss} not found</span>` : '') +
    (already ? `<span class="pill">${already} already there</span>` : '');
  $('#transferBtn').textContent = `Transfer ${sel} song${sel === 1 ? '' : 's'}`;
  $('#transferBtn').disabled = state.busy || !sel;
}

function progress(done, total, text) {
  $('#bar').style.width = total ? `${(100 * done) / total}%` : '0';
  $('#progressText').textContent = text;
}

function setBusy(b) {
  state.busy = b;
  $('#stopBtn').hidden = !b;
  $('#matchBtn').disabled = b;
  for (const sel of ['#sourceSelect', '#destSelect', '#fromService', '#toService', '#swapBtn']) $(sel).disabled = b;
  renderSummary();
}

async function refresh() {
  await Promise.all(Object.values(services).map((s) => s.restore()));
  renderAccounts();
  renderPlaylists();
}

/* ================================================================
 * Main flows
 * ================================================================ */

const searchCache = store.get('search_cache', {});
function cacheKey(to, s) { return to + '|' + norm(s.artist) + '|' + norm(s.title); }
function saveCache() { store.set('search_cache', searchCache); }

async function findMatches() {
  const from = services[fromId()], to = services[toId()];
  const srcId = $('#sourceSelect').value;
  const destId = $('#destSelect').value;
  if (!srcId) return;
  state.stop = false;
  state.rows = [];
  $('#reviewCard').hidden = false;
  $('#result').hidden = true;
  setBusy(true);
  try {
    progress(0, 0, 'Reading source playlist…');
    const songs = await from.readTracks(srcId);

    // What's already in the destination (so re-runs only add what's missing)
    let existing = new Set();
    if (destId !== '__new') {
      progress(0, 0, 'Reading destination playlist…');
      existing = new Set((await to.readTracks(destId)).map((t) => t.key));
    }

    state.rows = songs.map((s) => ({ src: s, match: null, score: 0, checked: false, pending: true }));
    renderRows();

    let i = 0;
    for (const row of state.rows) {
      if (state.stop) break;
      i++;
      progress(i, songs.length, `Matching ${i} / ${songs.length}: ${row.src.artist} — ${row.src.title}`);
      const key = cacheKey(toId(), row.src);
      let res = searchCache[key];
      if (!res) {
        res = await to.search(row.src);
        searchCache[key] = res;
        saveCache();
      }
      Object.assign(row, res, { pending: false, checked: !!res.match && res.score >= 0.5 });
      if (row.match && existing.has(row.match.key)) row.already = true;
      renderRows();
    }
    state.rows = state.rows.filter((r) => !r.pending);
    renderRows();
    progress(1, 1, state.stop ? 'Stopped. You can transfer what was matched so far.' : 'Matching done. Untick anything that looks wrong, then transfer.');
  } catch (e) {
    state.rows = state.rows.filter((r) => !r.pending);
    renderRows();
    progress(1, 1, e.message);
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
}

async function transfer() {
  const from = services[fromId()], to = services[toId()];
  const rows = state.rows.filter((r) => r.checked && r.match && !r.already && !r.done);
  if (!rows.length) return;
  let destId = $('#destSelect').value;
  const name = $('#newName').value.trim() || $('#newName').placeholder;
  state.stop = false;
  setBusy(true);
  let added = 0;
  try {
    if (destId === '__new') destId = await to.createPlaylist(name, from.name);
    await to.addTracks(destId, rows, (chunk) => {
      chunk.forEach((r) => (r.done = true));
      added += chunk.length;
      progress(added, rows.length, `Added ${added} / ${rows.length}`);
      if (chunk.length > 1 || added % 5 === 0 || added === rows.length) renderRows();
    });
    // keep "Add to" pointing at this playlist so a re-run continues it
    renderPlaylists();
    $('#destSelect').value = destId;
    updateDestFields();
  } catch (e) {
    toast(e.message, true);
    progress(added, rows.length, e.message);
  } finally {
    setBusy(false);
    renderRows();
  }
  const el = $('#result');
  el.hidden = false;
  el.innerHTML = `Added <b>${added}</b> song${added === 1 ? '' : 's'} to ${esc(to.name)}. ` +
    (destId !== '__new' ? `<a href="${esc(to.playlistUrl(destId))}" target="_blank" rel="noopener">Open playlist →</a>` : '');
}

function exportUnmatched() {
  const lines = state.rows.filter((r) => !r.done && !r.already && (!r.match || !r.checked))
    .map((r) => `${r.src.artist} - ${r.src.title}\t${r.src.url || ''}`);
  if (!lines.length) return toast('Nothing unmatched 🎉');
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'unmatched-songs.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ================================================================
 * Wire up
 * ================================================================ */

let lastDirection = ['spotify', 'youtube'];

function onDirectionChange(changed) {
  // picking the same service on both sides swaps them instead
  if (fromId() === toId()) {
    if (changed === 'from') $('#toService').value = lastDirection[0];
    else $('#fromService').value = lastDirection[1];
  }
  lastDirection = [fromId(), toId()];
  store.set('direction', lastDirection);
  state.rows = [];
  $('#reviewCard').hidden = true;
  renderPlaylists();
}

function init() {
  document.querySelectorAll('[data-copy-redirect]').forEach((el) => (el.textContent = REDIRECT_URI));
  document.querySelectorAll('[data-copy-origin]').forEach((el) => (el.textContent = location.origin));
  document.querySelectorAll('code.copy').forEach((el) =>
    el.addEventListener('click', () => navigator.clipboard?.writeText(el.textContent).then(() => toast('Copied'))));

  const dir = store.get('direction');
  if (dir && services[dir[0]] && services[dir[1]] && dir[0] !== dir[1]) {
    $('#fromService').value = dir[0];
    $('#toService').value = dir[1];
    lastDirection = dir;
  }

  $('#openSettings').onclick = openSettings;
  $('#setupLink').onclick = (e) => { e.preventDefault(); openSettings(); };
  $('#saveSettings').onclick = () => {
    store.set('cfg', {
      spotifyClientId: $('#spClientId').value.trim(),
      googleClientId: $('#ggClientId').value.trim(),
      appleDevToken: $('#amDevToken').value.trim(),
    });
    amConfigured = null;
    refresh();
  };
  $('#amGenerate').onclick = async () => {
    const file = $('#amKeyFile').files[0];
    const teamId = $('#amTeamId').value.trim(), keyId = $('#amKeyId').value.trim();
    if (!file || !teamId || !keyId) return toast('Fill in Team ID, Key ID and choose your .p8 file', true);
    try {
      $('#amDevToken').value = await generateAppleToken(teamId, keyId, await file.text());
      $('#amKeyFile').value = '';
      toast('Token generated. Click Save.');
    } catch (e) {
      toast('Could not read that key: ' + (e.message || e), true);
    }
  };

  for (const [id, svc] of Object.entries(services)) {
    $(`#${id}Connect`).onclick = async (e) => {
      if (!svc.hasConfig()) {
        toast(`${svc.name} isn't set up on this site yet. Add its key in Site setup.`, true);
        return openSettings();
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = `Opening ${svc.name}…`;
      // Spotify and YouTube leave the page for their sign-in; Apple signs in through its own window
      let result;
      try { result = await svc.connect(); }
      finally {
        if (result !== 'redirect') { btn.disabled = false; btn.textContent = 'Connect'; }
      }
      renderAccounts();
      renderPlaylists();
    };
    $(`#${id}Logout`).onclick = () => { svc.disconnect(); renderAccounts(); renderPlaylists(); };
  }
  // Coming back with the browser's Back button from a sign-in page restores the old page state
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const id of Object.keys(services)) { $(`#${id}Connect`).disabled = false; $(`#${id}Connect`).textContent = 'Connect'; }
  });

  $('#fromService').onchange = () => onDirectionChange('from');
  $('#toService').onchange = () => onDirectionChange('to');
  $('#swapBtn').onclick = () => {
    const f = fromId();
    $('#fromService').value = toId();
    $('#toService').value = f;
    onDirectionChange('swap');
  };
  $('#sourceSelect').onchange = updateDestFields;
  $('#destSelect').onchange = updateDestFields;
  $('#matchBtn').onclick = findMatches;
  $('#stopBtn').onclick = () => { state.stop = true; };
  $('#transferBtn').onclick = transfer;
  $('#exportBtn').onclick = exportUnmatched;
  $('#matchTable tbody').addEventListener('change', (e) => {
    const i = e.target.dataset?.i;
    if (i !== undefined) { state.rows[i].checked = e.target.checked; renderSummary(); }
  });

  // Configure MusicKit early so the Connect click can open Apple's sign-in popup right away
  const preconfigure = () => { if (cfg().appleDevToken) amConfigure().catch(() => {}); };
  if (window.MusicKit) preconfigure(); else document.addEventListener('musickitloaded', preconfigure);

  handleGoogleCallback();
  handleSpotifyCallback()
    .catch((e) => toast(e.message, true))
    .finally(refresh);
}

init();
