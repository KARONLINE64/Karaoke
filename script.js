
let songs = [];
let searchIndex = [];
let currentSongs = [];
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");
const catalogCache = {};
const favoriteSongMetaKey = "favoriteSongMeta";
let favoriteSongMeta = JSON.parse(localStorage.getItem(favoriteSongMetaKey) || "{}");

for (const key of favorites) {
  if (!favoriteSongMeta[key]) {
    const [artist = "", title = ""] = key.split("|");
    if (artist || title) {
      favoriteSongMeta[key] = { artist, title };
    }
  }
}

const search = document.getElementById("search");

const homePage = document.getElementById("homePage");
const catalogPage = document.getElementById("catalogPage");
const newPage = document.getElementById("newPage");
const songsPage = document.getElementById("songsPage");

const songsDiv = document.getElementById("songs");

const homeBtn = document.getElementById("homeBtn");
const catalogBtn = document.getElementById("catalogBtn");
const newBtn = document.getElementById("newBtn");
const favBtn = document.getElementById("favBtn");
const requestBtn = document.getElementById("requestBtn");

const virtualState = {
  initialized: false,
  spacer: null,
  content: null,
  pool: [],
  itemHeight: 0,
  buffer: 4,
  visibleCount: 0,
  currentList: [],
  version: 0
};

let renderPending = false;

function persistFavoriteState() {
  localStorage.setItem("favorites", JSON.stringify(favorites));
  localStorage.setItem(favoriteSongMetaKey, JSON.stringify(favoriteSongMeta));
}

function addFavorite(key, song) {
  if (!favorites.includes(key)) {
    favorites.push(key);
  }

  const artist = song && song.artist ? song.artist : "";
  const title = song && song.title ? song.title : "";

  if (artist && title) {
    favoriteSongMeta[key] = { artist, title };
  } else {
    const [artistFromKey = "", titleFromKey = ""] = key.split("|");
    if (artistFromKey || titleFromKey) {
      favoriteSongMeta[key] = { artist: artistFromKey, title: titleFromKey };
    }
  }

  persistFavoriteState();
}

function removeFavorite(key) {
  favorites = favorites.filter(x => x !== key);
  delete favoriteSongMeta[key];
  persistFavoriteState();
}

function hideAllPages() {
  homePage.classList.add("hidden");
  catalogPage.classList.add("hidden");
  newPage.classList.add("hidden");
  songsPage.classList.add("hidden");
}

function showHome() {
  hideAllPages();
  homePage.classList.remove("hidden");
  search.value = "";
}

function showCatalog() {
  hideAllPages();
  catalogPage.classList.remove("hidden");
  search.value = "";
}

function showNew() {
  hideAllPages();
  newPage.classList.remove("hidden");
  search.value = "";
}

function showSongs(list) {
  hideAllPages();
  songsPage.classList.remove("hidden");
  drawSongs(list);
}

function drawSongs(list) {
  currentSongs = list;
  ensureVirtualList();
  virtualState.currentList = list;
  virtualState.version += 1;
  resetVirtualPool();
  songsDiv.scrollTop = 0;
  updateSongsContainerHeight();
  renderVisibleSongs();
}

function resetVirtualPool() {
  for (const item of virtualState.pool) {
    item.dataset.index = "";
    item.__listVersion = null;
    item.style.display = "none";
  }
}

function ensureVirtualList() {
  if (virtualState.initialized) {
    return;
  }

  songsDiv.style.position = "relative";
  songsDiv.style.overflowY = "auto";
  songsDiv.style.WebkitOverflowScrolling = "touch";
  songsDiv.style.boxSizing = "border-box";
  songsDiv.style.width = "100%";

  songsDiv.innerHTML = "";

  const spacer = document.createElement("div");
  spacer.style.width = "1px";
  spacer.style.height = "0";

  const content = document.createElement("div");
  content.style.position = "absolute";
  content.style.left = "0";
  content.style.top = "0";
  content.style.width = "100%";

  songsDiv.appendChild(spacer);
  songsDiv.appendChild(content);

  virtualState.spacer = spacer;
  virtualState.content = content;

  songsDiv.addEventListener("scroll", () => {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        renderVisibleSongs();
      });
    }
  });

  window.addEventListener("resize", () => {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        updateSongsContainerHeight();
        renderVisibleSongs();
      });
    }
  });

  songsDiv.addEventListener("click", event => {
    const star = event.target.closest(".star");
    if (!star || !songsDiv.contains(star)) {
      return;
    }

    const key = star.dataset.key;
    if (!key) {
      return;
    }

    const isFavorite = favorites.includes(key);
    if (isFavorite) {
      removeFavorite(key);
    } else {
      addFavorite(key, {
        artist: star.dataset.artist || key.split("|")[0],
        title: star.dataset.title || key.split("|")[1]
      });
    }

    updateRenderedStars(key);
  });

  virtualState.initialized = true;
}

function updateRenderedStars(key) {
  const selected = favorites.includes(key);
  for (const item of virtualState.pool) {
    if (item.__star && item.__star.dataset.key === key) {
      item.__star.textContent = selected ? "★" : "☆";
      item.__star.className = selected ? "star selected" : "star";
    }
  }
}

function updateSongsContainerHeight() {
  const rect = songsDiv.getBoundingClientRect();
  const bottomNavHeight = 70;
  const available = window.innerHeight - rect.top - bottomNavHeight;

  songsDiv.style.height = available > 120 ? `${available}px` : "120px";

  if (!virtualState.itemHeight) {
    virtualState.itemHeight = measureSongItemHeight() || 100;
  }

  virtualState.visibleCount = Math.ceil(songsDiv.clientHeight / virtualState.itemHeight) + virtualState.buffer * 2;
  ensurePoolSize(virtualState.visibleCount);
}

function measureSongItemHeight() {
  const sample = createSongElement();
  sample.style.visibility = "hidden";
  sample.style.position = "absolute";
  sample.style.left = "0";
  sample.style.top = "0";
  songsDiv.appendChild(sample);

  const rect = sample.getBoundingClientRect();
  const style = window.getComputedStyle(sample);
  const margin = parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0");
  sample.remove();

  return rect.height + margin;
}

function createSongElement() {
  const songEl = document.createElement("div");
  songEl.className = "song";
  songEl.style.width = "100%";
  songEl.style.boxSizing = "border-box";
  songEl.style.position = "absolute";

  const left = document.createElement("div");
  const artistEl = document.createElement("div");
  artistEl.className = "artist";
  const titleEl = document.createElement("div");
  titleEl.className = "title";
  left.appendChild(artistEl);
  left.appendChild(titleEl);

  const starEl = document.createElement("div");
  starEl.className = "star";

  songEl.appendChild(left);
  songEl.appendChild(starEl);

  songEl.__artist = artistEl;
  songEl.__title = titleEl;
  songEl.__star = starEl;

  // Allow selecting a song by clicking the item (ignore clicks on the star)
  songEl.addEventListener('click', (e) => {
    if (e.target.closest('.star')) return;
    const idx = songEl.dataset.index;
    if (!idx) return;
    const song = virtualState.currentList[Number(idx)];
    if (!song) return;
    selectedSongKey = song.artist + '|' + song.title;
    for (const it of virtualState.pool) {
      it.classList.toggle('selected', it.dataset.index === String(idx));
    }
  });

  return songEl;
}

function ensurePoolSize(size) {
  while (virtualState.pool.length < size) {
    const item = createSongElement();
    item.style.display = "none";
    item.dataset.index = "";
    virtualState.content.appendChild(item);
    virtualState.pool.push(item);
  }
}

function renderVisibleSongs() {
  const list = virtualState.currentList || [];

  if (!list.length) {
    virtualState.spacer.style.height = "0";
    virtualState.content.style.transform = "translateY(0px)";
    for (const item of virtualState.pool) {
      item.style.display = "none";
      item.dataset.index = "";
    }
    return;
  }

  if (!virtualState.itemHeight) {
    virtualState.itemHeight = measureSongItemHeight() || 100;
  }

  const totalHeight = list.length * virtualState.itemHeight;
  virtualState.spacer.style.height = `${totalHeight}px`;

  const scrollTop = songsDiv.scrollTop;
  const firstVisible = Math.floor(scrollTop / virtualState.itemHeight);
  const start = Math.max(0, firstVisible - virtualState.buffer);
  const visibleCount = Math.ceil(songsDiv.clientHeight / virtualState.itemHeight) + virtualState.buffer * 2;
  const end = Math.min(list.length, start + visibleCount);

  virtualState.content.style.transform = `translateY(${start * virtualState.itemHeight}px)`;

  let displayCount = 0;
  for (let index = start; index < end; index += 1) {
    const item = virtualState.pool[displayCount];
    const song = list[index];
    const key = song.artist + "|" + song.title;
    const selected = favorites.includes(key);

    const needsUpdate = item.dataset.index !== String(index) || item.__listVersion !== virtualState.version;
    if (needsUpdate) {
      item.__artist.textContent = song.artist;
      item.__title.textContent = song.title;
      item.__star.dataset.key = key;
      item.__star.dataset.artist = song.artist;
      item.__star.dataset.title = song.title;
      item.__star.textContent = selected ? "★" : "☆";
      item.__star.className = selected ? "star selected" : "star";
      item.dataset.index = String(index);
      item.__listVersion = virtualState.version;
    }

    // reflect selection state
    item.classList.toggle('selected', selectedSongKey === key);

    item.style.top = `${displayCount * virtualState.itemHeight}px`;
    item.style.display = "flex";
    displayCount += 1;
  }

  for (let i = displayCount; i < virtualState.pool.length; i += 1) {
    virtualState.pool[i].style.display = "none";
    virtualState.pool[i].dataset.index = "";
  }
}

async function loadLanguage(file) {
  if (catalogCache[file]) {
    currentSongs = catalogCache[file];
    showSongs(currentSongs);
    return;
  }

  const response = await fetch(file);
  const data = await response.json();
  catalogCache[file] = data;
  currentSongs = data;
  showSongs(currentSongs);
}

fetch("songs.json")
  .then(response => response.json())
  .then(data => {
    songs = data.sort((a, b) => {
      if (a.artist === b.artist) {
        return a.title.localeCompare(b.title);
      }
      return a.artist.localeCompare(b.artist);
    });

    searchIndex = songs.map(song => ({
      song,
      normalized: `${song.artist.toLowerCase()}|${song.title.toLowerCase()}`
    }));

    showHome();
  });

search.addEventListener("input", function () {
  const value = search.value.trim().toLowerCase();

  if (value === "") {
    showHome();
    return;
  }

  const result = [];
  for (const entry of searchIndex) {
    if (entry.normalized.includes(value)) {
      result.push(entry.song);
    }
  }

  currentSongs = result;
  showSongs(currentSongs);
});

homeBtn.onclick = function () {
  showHome();
};

catalogBtn.onclick = function () {
  showCatalog();
};

newBtn.onclick = function () {
  showNew();
};

favBtn.onclick = function () {
  const combined = [];

  for (const s of songs) {
    if (s && s.artist && s.title) combined.push(s);
  }

  for (const k in catalogCache) {
    const list = catalogCache[k];
    if (Array.isArray(list)) {
      for (const s of list) {
        if (s && s.artist && s.title) combined.push(s);
      }
    }
  }

  for (const key of favorites) {
    const song = favoriteSongMeta[key];
    if (song && song.artist && song.title) {
      combined.push({ artist: song.artist, title: song.title });
    } else {
      const [artist = "", title = ""] = key.split("|");
      if (artist || title) {
        combined.push({ artist, title });
      }
    }
  }

  const seen = new Set();
  currentSongs = combined.filter(song => {
    const key = song.artist + "|" + song.title;
    if (!favorites.includes(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  showSongs(currentSongs);
};

document.querySelectorAll(".catalogItem").forEach(item => {
  item.onclick = function () {
    loadLanguage(this.dataset.file);
  };
});

// --- Request feature: modal, search, and submit to local API ---
// Request UI elements (created in index.html)
const requestModal = document.getElementById('requestModal');
const reqSongSearch = document.getElementById('reqSongSearch');
const requestResults = document.getElementById('requestResults');
const reqArtist = document.getElementById('reqArtist');
const reqTitle = document.getElementById('reqTitle');
const reqSinger = document.getElementById('reqSinger');
const reqKey = document.getElementById('reqKey');
const sendRequestBtn = document.getElementById('sendRequestBtn');
const cancelRequestBtn = document.getElementById('cancelRequestBtn');
const requestStatus = document.getElementById('requestStatus');

let selectedSongKey = null;
let requestSelectedSong = null;
const requestSongIndex = new Map();

function buildRequestSongIndex() {
  requestSongIndex.clear();
  const add = s => {
    if (!s || !s.artist || !s.title) return;
    const key = s.artist + '|' + s.title;
    if (!requestSongIndex.has(key)) {
      requestSongIndex.set(key, { artist: s.artist, title: s.title });
    }
  };
  for (const s of songs) add(s);
  for (const k in catalogCache) {
    const list = catalogCache[k];
    if (Array.isArray(list)) {
      for (const s of list) add(s);
    }
  }
}

function renderRequestResults(list) {
  requestResults.innerHTML = '';
  requestResults.style.display = 'block';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'requestResult';
    empty.textContent = 'No song found.';
    requestResults.appendChild(empty);
    return;
  }
  list.slice(0, 20).forEach(item => {
    const row = document.createElement('div');
    row.className = 'requestResult';
    row.textContent = item.artist + ' — ' + item.title;
    row.dataset.key = item.artist + '|' + item.title;
    row.addEventListener('click', () => {
      requestSelectedSong = item;
      reqArtist.value = item.artist;
      reqTitle.value = item.title;
      document.querySelectorAll('.requestResult').forEach(el => el.classList.toggle('selected', el === row));
      requestResults.innerHTML = '';
      requestResults.style.display = 'none';
      requestStatus.textContent = '';
    });
    requestResults.appendChild(row);
  });
}

function searchRequestSongs(query) {
  const term = query.trim().toLowerCase();
  if (!term) {
    requestResults.innerHTML = '';
    requestResults.style.display = 'none';
    requestSelectedSong = null;
    reqArtist.value = '';
    reqTitle.value = '';
    return;
  }
  const results = [];
  for (const item of requestSongIndex.values()) {
    const text = (item.artist + ' ' + item.title).toLowerCase();
    if (text.includes(term)) {
      results.push(item);
    }
  }
  renderRequestResults(results);
}

function openRequestModal() {
  buildRequestSongIndex();
  reqSongSearch.value = '';
  requestResults.innerHTML = '';
  requestSelectedSong = null;
  reqArtist.value = '';
  reqTitle.value = '';
  reqSinger.value = '';
  requestStatus.textContent = '';
  reqKey.value = '0';
  requestModal.classList.remove('hidden');
}

function closeRequestModal() { requestModal.classList.add('hidden'); }

function buildKeyOptions() {
  reqKey.innerHTML = '';
  const optNormal = document.createElement('option'); optNormal.value = '0'; optNormal.textContent = 'Normal'; reqKey.appendChild(optNormal);
  for (let i = 1; i <= 12; i++) { const p = document.createElement('option'); p.value = String(i); p.textContent = '+'+i; reqKey.appendChild(p); }
  for (let i = 1; i <= 12; i++) { const n = document.createElement('option'); n.value = String(-i); n.textContent = String(-i); reqKey.appendChild(n); }
}

reqSongSearch && reqSongSearch.addEventListener('input', () => searchRequestSongs(reqSongSearch.value));

const requestBox = requestModal && requestModal.querySelector('.rb-box');
const requestOverlay = requestModal && requestModal.querySelector('.rb-overlay');

requestBtn && requestBtn.addEventListener('click', () => openRequestModal());
cancelRequestBtn && cancelRequestBtn.addEventListener('click', () => closeRequestModal());

requestOverlay && requestOverlay.addEventListener('click', () => closeRequestModal());

requestBox && requestBox.addEventListener('click', event => {
  if (requestResults.style.display !== 'block') return;
  const target = event.target;
  if (target === reqSongSearch || requestResults.contains(target)) return;
  requestResults.innerHTML = '';
  requestResults.style.display = 'none';
});

sendRequestBtn && sendRequestBtn.addEventListener('click', async () => {
  const artist = reqArtist.value.trim();
  const title = reqTitle.value.trim();
  const singer = reqSinger.value.trim();
  const keyChange = parseInt(reqKey.value, 10);
  if (!requestSelectedSong || !artist || !title) { requestStatus.textContent = 'Please select a song.'; return; }
  if (!singer) { requestStatus.textContent = 'Please enter singer name.'; return; }
  const payload = { artist, title, singer, keyChange };
  console.log('REQUEST SENDING', payload);
  try {
    const res = await fetch('http://localhost:3000/request', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('network');
    requestStatus.textContent = 'Request sent successfully.';
    setTimeout(() => closeRequestModal(), 1100);
  } catch (err) {
    console.error('Request error', err);
    requestStatus.textContent = 'Request failed. Please try again.';
  }
});

buildKeyOptions();
