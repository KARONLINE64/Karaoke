let songs = [];
let currentSongs = [];
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");

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
  let html = "";

  for (const song of list) {
    const key = song.artist + "|" + song.title;
    const selected = favorites.includes(key);

    html += `
<div class="song">
  <div>
    <div class="artist">${song.artist}</div>
    <div class="title">${song.title}</div>
  </div>
  <div class="star ${selected ? "selected" : ""}" data-key="${key}">
    ${selected ? "★" : "☆"}
  </div>
</div>`;
  }

  songsDiv.innerHTML = html;

  songsDiv.querySelectorAll(".star").forEach(star => {
    star.onclick = function (e) {
      e.stopPropagation();
      const key = this.dataset.key;

      if (favorites.includes(key)) {
        favorites = favorites.filter(x => x !== key);
        this.textContent = "☆";
        this.classList.remove("selected");
      } else {
        favorites.push(key);
        this.textContent = "★";
        this.classList.add("selected");
      }

      localStorage.setItem("favorites", JSON.stringify(favorites));
    };
  });
}

async function loadLanguage(file) {
  const response = await fetch(file);
  const data = await response.json();
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
    showHome();
  });

search.addEventListener("input", function () {
  const value = search.value.trim().toLowerCase();

  if (value === "") {
    showHome();
    return;
  }

  const result = songs.filter(song =>
    song.artist.toLowerCase().includes(value) ||
    song.title.toLowerCase().includes(value)
  );

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