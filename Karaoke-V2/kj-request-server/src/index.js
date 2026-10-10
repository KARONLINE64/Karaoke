// Serveur des espaces KJ (KaroliveBox KJ) : « karolive-kj ».
// Séparé du serveur OpenKJ du KJ propriétaire (cloudflare-request-server),
// qui n'est pas modifié. Toute la logique est dans kj.js.
import { handleKj } from "./kj.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("karolive-kj : serveur des espaces KJ (KaroliveBox KJ)\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return handleKj(request, env, url);
  },
};
