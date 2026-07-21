let songs = [];

const songsDiv = document.getElementById("songs");
const search = document.getElementById("search");

fetch("songs.json")
  .then(response => response.json())
  .then(data => {
    songs = data.sort((a, b) => {
      if (a.artist === b.artist) {
        return a.title.localeCompare(b.title);
      }
      return a.artist.localeCompare(b.artist);
    });

    display(songs);
  });

function display(list) {

  songsDiv.innerHTML = "";

  list.forEach(song => {

    const card = document.createElement("div");
    card.className = "song";

    const left = document.createElement("div");

    const artist = document.createElement("div");
    artist.className = "artist";
    artist.textContent = song.artist;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = song.title;

    left.appendChild(artist);
    left.appendChild(title);

    const star = document.createElement("div");
    star.className = "star";
    star.textContent = "☆";

    card.appendChild(left);
    card.appendChild(star);

    songsDiv.appendChild(card);

  });

}

search.addEventListener("input", function () {

  const value = search.value.toLowerCase();

  const result = songs.filter(song =>
    song.artist.toLowerCase().includes(value) ||
    song.title.toLowerCase().includes(value)
  );

  display(result);

});
