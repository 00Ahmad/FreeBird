import { createServer, type Server } from "node:http";

/**
 * A shop whose listings are filled in by JavaScript after the page loads (like the shops plain fetching can't
 * read), with a product page, a "Buy now" button, a password field and a human-check page.
 */
export function shop(): Server {
  const products = [
    { id: 1, name: "Nova 5 4GB/128GB", price: "Rs. 29,999" },
    { id: 2, name: "Pixelto A2 6GB/128GB", price: "Rs. 34,500" },
  ];
  const page = (body: string) =>
    `<!doctype html><html><head><title>Fixture Shop</title></head><body>${body}</body></html>`;
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(body));
    };
    if (url.pathname === "/api/products") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          products.filter(
            (p) => !q || /^(mobile |smart)?phones?$/.test(q) || p.name.toLowerCase().includes(q),
          ),
        ),
      );
      return;
    }
    if (url.pathname === "/") {
      return html(`<form action="/search"><input type="search" name="q" placeholder="Search products"></form>
        <a href="/login">Sign in</a>`);
    }
    if (url.pathname === "/search") {
      return html(`<h1>Results</h1><div id="list">Loading…</div>
        <script>fetch("/api/products?q=" + encodeURIComponent(new URLSearchParams(location.search).get("q") || ""))
          .then((r) => r.json()).then((items) => {
            document.getElementById("list").innerHTML = items.map((p) =>
              '<div><a href="/p/' + p.id + '">' + p.name + '</a> <span>' + p.price + '</span></div>').join("");
          });</script>`);
    }
    if (url.pathname.startsWith("/p/")) {
      const product = products.find((p) => `/p/${p.id}` === url.pathname);
      return html(`<h1>${product?.name}</h1><p>Price: ${product?.price}</p><button>Buy now</button>`);
    }
    if (url.pathname === "/login") {
      return html(`<form method="post" action="/welcome">
        <input type="email" name="e" aria-label="Email"><input type="password" name="p" aria-label="Password">
        <button>Sign in</button>
      </form>`);
    }
    // Says who signed in and how long the password was, never the password itself.
    if (url.pathname === "/welcome" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        html(`<h1>Signed in as ${form.get("e")}</h1><p>Password length ${form.get("p")?.length ?? 0}</p>`);
      });
      return;
    }
    if (url.pathname === "/check") return html(`<p>Please verify you are human to continue.</p>`);
    // A mail page: a search box, a reply box, a Send button, an icon-only button and a link to a new tab.
    if (url.pathname === "/compose") {
      return html(`<input type="search" aria-label="Search mail"><br>
        <textarea name="body" placeholder="Write a reply"></textarea><br>
        <button>Send</button>
        <button id="bin" style="width:28px;height:28px"><span style="display:inline-block;width:14px;height:14px;background:#555"></span></button>
        <button onclick="this.textContent = 'Starred'">Star</button>
        <a href="/p/1" target="_blank">Open in a new tab</a>`);
    }
    // A page whose script calls the address given in ?to= (like a page probing a router).
    if (url.pathname === "/probe") {
      return html(`<h1>Probe</h1><script>fetch(${JSON.stringify(url.searchParams.get("to") ?? "")}, { mode: "no-cors" })
        .then(() => (document.title = "reached"), () => (document.title = "blocked"));</script>`);
    }
    // Long text, and a script that keeps adding buttons at the top (like ads loading in).
    if (url.pathname === "/long") {
      return html(`<p>${"Plenty of words to read here. ".repeat(400)}</p><a href="/">Home</a>
        <script>let n = 0; setInterval(() => document.body.prepend(Object.assign(document.createElement("button"), { textContent: "Ad " + ++n })), 150);</script>`);
    }
    res.writeHead(404).end();
  });
}
