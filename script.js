let songs = [];
let searchIndex = [];
let currentSongs = [];
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");
const catalogCache = {};

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
      favorites = favorites.filter(x => x !== key);
    } else {
      favorites.push(key);
    }

    localStorage.setItem("favorites", JSON.stringify(favorites));
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
      item.__star.textContent = selected ? "★" : "☆";
      item.__star.className = selected ? "star selected" : "star";
      item.dataset.index = String(index);
      item.__listVersion = virtualState.version;
    }

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
  currentSongs = songs.filter(song =>
    favorites.includes(song.artist + "|" + song.title)
  );
  showSongs(currentSongs);
};

document.querySelectorAll(".catalogItem").forEach(item => {
  item.onclick = function () {
    loadLanguage(this.dataset.file);
  };
});