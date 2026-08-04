let songs = [];
let currentSongs = [];
const languageCache = {};
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");

const search = document.getElementById("search");

const homePage = document.getElementById("homePage");
const catalogPage = document.getElementById("catalogPage");
const songsPage = document.getElementById("songsPage");

const songsDiv = document.getElementById("songs");

const homeBtn = document.getElementById("homeBtn");
const catalogBtn = document.getElementById("catalogBtn");
const favBtn = document.getElementById("favBtn");

function showHome(){

homePage.classList.remove("hidden");

catalogPage.classList.add("hidden");

songsPage.classList.add("hidden");

search.value="";

}

function showCatalog(){

homePage.classList.add("hidden");

catalogPage.classList.remove("hidden");

songsPage.classList.add("hidden");

search.value="";

}

function showSongs(list){

homePage.classList.add("hidden");

catalogPage.classList.add("hidden");

songsPage.classList.remove("hidden");

drawSongs(list);

}

function drawSongs(list){

songsDiv.innerHTML="";

currentSongs=list;

list.forEach(song=>{

const card=document.createElement("div");

card.className="song";

const left=document.createElement("div");

const artist=document.createElement("div");

artist.className="artist";

artist.textContent=song.artist;

const title=document.createElement("div");

title.className="title";

title.textContent=song.title;

left.appendChild(artist);

left.appendChild(title);

const star=document.createElement("div");

star.className="star";

const key=song.artist+"|"+song.title;

if(favorites.includes(key)){

star.textContent="★";

star.classList.add("selected");

}else{

star.textContent="☆";

}
star.onclick=function(){

if(favorites.includes(key)){

favorites=favorites.filter(item=>item!==key);

star.textContent="☆";

star.classList.remove("selected");

}else{

favorites.push(key);

star.textContent="★";

star.classList.add("selected");

}

localStorage.setItem(

"favorites",

JSON.stringify(favorites)

);

};

card.appendChild(left);

card.appendChild(star);

songsDiv.appendChild(card);

});

}

async function loadLanguage(file){

if(languageCache[file]){

currentSongs=languageCache[file];

showSongs(currentSongs);

return;

}

const response=await fetch(file);

const data=await response.json();

languageCache[file]=data;

currentSongs=data;

showSongs(currentSongs);

}

fetch("songs.json")

.then(response=>response.json())

.then(data=>{

songs=data.sort((a,b)=>{

if(a.artist===b.artist){

return a.title.localeCompare(b.title);

}

return a.artist.localeCompare(b.artist);

});

showHome();

});
search.addEventListener("input",function(){

const value=search.value.trim().toLowerCase();

if(value===""){

showHome();

return;

}

const result=songs.filter(song=>

song.artist.toLowerCase().includes(value)

||

song.title.toLowerCase().includes(value)

);

currentSongs=result;

showSongs(currentSongs);

});

homeBtn.onclick=function(){

showHome();

};

catalogBtn.onclick=function(){

showCatalog();

};

favBtn.onclick=function(){

currentSongs=songs.filter(song=>

favorites.includes(song.artist+"|"+song.title)

);

showSongs(currentSongs);

};

document.querySelectorAll(".catalogItem").forEach(item=>{

item.onclick=function(){

loadLanguage(this.dataset.file);

};

});