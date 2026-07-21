const songs = [
  { artist: "Queen", title: "Bohemian Rhapsody" },
  { artist: "ABBA", title: "Dancing Queen" },
  { artist: "Adele", title: "Hello" },
  { artist: "Elvis Presley", title: "Can't Help Falling In Love" }
];

const songsDiv = document.getElementById("songs");
const search = document.getElementById("search");

function display(list) {
  songsDiv.innerHTML = "";

  for (let i = 0; i < list.length; i++) {

    const card = document.createElement("div");
    card.className = "song";

    const left = document.createElement("div");

    const artist = document.createElement("div");
    artist.className = "artist";
    artist.textContent = list[i].artist;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = list[i].title;

    left.appendChild(artist);
    left.appendChild(title);

    const star = document.createElement("div");
    star.className = "star";
    star.textContent = "⭐";

    card.appendChild(left);
    card.appendChild(star);

    songsDiv.appendChild(card);
  }
}

display(songs);

search.addEventListener("input", function () {

  const value = search.value.toLowerCase();

  const result = songs.filter(function (song) {
    return (
      song.artist.toLowerCase().includes(value) ||
      song.title.toLowerCase().includes(value)
    );
  });

  display(result);

});
