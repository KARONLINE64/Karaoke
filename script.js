const songs = [
    {artist:"Queen", title:"Bohemian Rhapsody"},
    {artist:"ABBA", title:"Dancing Queen"},
    {artist:"Adele", title:"Hello"},
    {artist:"Elvis Presley", title:"Can't Help Falling In Love"},
    {artist:"Johnny Hallyday", title:"Que je t'aime"},
    {artist:"Ed Sheeran", title:"Perfect"},
    {artist:"Bruno Mars", title:"Uptown Funk"},
    {artist:"Céline Dion", title:"Pour que tu m'aimes encore"}
];

const songsDiv = document.getElementById("songs");
const search = document.getElementById("search");

function display(list){

    songsDiv.innerHTML="";

    list.forEach(song=>{

        songsDiv.innerHTML += `
        <div class="song">
            <div>
                <div class="artist">${song.artist}</div>
                <div class="title">${song.title}</div>
            </div>

            <div class="star">⭐</div>

        </div>`;
    });

}

display(songs);

search.addEventListener("input",()=>{

    const value = search.value.toLowerCase();

    const result = songs.filter(song =>
        song.artist.toLowerCase().includes(value) ||
        song.title.toLowerCase().includes(value)
    );

    display(result);

});
