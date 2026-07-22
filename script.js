let songs = [];

const songsDiv = document.getElementById("songs");
const search = document.getElementById("search");
const homeBtn = document.getElementById("homeBtn");
const favBtn = document.getElementById("favBtn");
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

        const id = song.artist + " - " + song.title;

        let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");

        if (favorites.includes(id)) {
            star.textContent = "★";
            star.classList.add("selected");
        } else {
            star.textContent = "☆";
        }

        star.onclick = function () {

            let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");

            if (favorites.includes(id)) {

                favorites = favorites.filter(item => item !== id);

                star.textContent = "☆";
                star.classList.remove("selected");

            } else {

                favorites.push(id);

                star.textContent = "★";
                star.classList.add("selected");

            }

            localStorage.setItem("favorites", JSON.stringify(favorites));

        };

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
homeBtn.onclick = function () {

    search.value = "";
    display(songs);

};

favBtn.onclick = function () {

    const favorites = JSON.parse(localStorage.getItem("favorites") || "[]");

    const list = songs.filter(song =>
        favorites.includes(song.artist + " - " + song.title)
    );

    search.value = "";
    display(list);

};
