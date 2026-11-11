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
    // A check that goes away after a moment, as when the user solves it.
    if (url.pathname === "/solvable") {
      return html(`<p id="gate">Please verify you are human to continue.</p>
        <script>setTimeout(() => { document.body.innerHTML = "<h1>Results</h1><p>" + "Plenty of results. ".repeat(200) + "</p>"; }, 1500);</script>`);
    }
    // A mail page: a search box, a reply box, a Send button, an icon-only button and a link to a new tab.
    if (url.pathname === "/compose") {
      return html(`<input type="search" aria-label="Search mail"><br>
        <textarea name="body" placeholder="Write a reply"></textarea><br>
        <button>Send</button>
        <button id="bin" style="width:28px;height:28px"><span style="display:inline-block;width:14px;height:14px;background:#555"></span></button>
        <button onclick="this.textContent = 'Starred'">Star</button>
        <a href="/p/1" target="_blank">Open in a new tab</a>`);
    }
    // A harmless "Next page" button under a see-through "Subscribe now" layer (like a pop-up over a page), and a
    // made-up checkbox whose input sits under its picture (as many sites draw them).
    if (url.pathname === "/covered") {
      // ?layer=off: nothing on top; ?layer=plain: a layer that is no control (like a video preview sliding over).
      const kind = url.searchParams.get("layer") ?? "subscribe";
      const layer = kind !== "off";
      const action = kind === "plain" ? "" : `onclick="document.title='subscribed'"`;
      return html(`<button id="next" style="position:absolute;left:300px;top:300px;width:160px;height:40px" onclick="document.title='next clicked'">Next page</button>
        <label style="position:absolute;left:300px;top:420px">
          <input type="checkbox" id="keep" onchange="document.title='kept'" style="position:absolute;left:0;top:0;width:20px;height:20px;margin:0">
          <span style="position:relative;display:inline-block;width:20px;height:20px;background:#ccc"></span> Keep me posted
        </label>
        <label style="position:absolute;left:300px;top:480px"><input type="checkbox"> I agree to the terms</label>
        ${layer ? `<div ${action} style="position:fixed;left:0;top:0;width:100%;height:380px;background:rgba(255,255,255,0.01)">${kind === "plain" ? "" : "Subscribe now"}</div>` : ""}`);
    }
    // An outlet whose own search finds nothing: what's on sale is only found by browsing its menu and pages, as on
    // shops whose search is poor. The Pixelto A2 is on the second page of Phones.
    if (url.pathname.startsWith("/outlet")) {
      // "/outlet/" and "/outlet" are the same page, as on real sites.
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const outlet = [
        ["Nova 5 Lite", "Rs. 24,999"],
        ["Kestrel 8", "Rs. 41,000"],
        ["Moto Breeze", "Rs. 22,450"],
        ["Galaxo M3", "Rs. 38,900"],
        ["Lumia Go", "Rs. 19,999"],
        ["Orbit X", "Rs. 45,500"],
        ["Pixelto A2 6GB/128GB", "Rs. 31,250"],
        ["Zenith 4", "Rs. 27,300"],
      ].map(([name, price], index) => ({ id: index + 1, name: name!, price: price! }));
      const menu = `<nav><a href="/outlet">Outlet home</a> · <a href="/outlet/phones">Phones</a> · <a href="/outlet/laptops">Laptops</a> · <a href="/outlet/deals">Deals</a></nav>
        <form action="/outlet/search"><input type="search" name="q" placeholder="Search the outlet"></form>`;
      if (path === "/outlet")
        return html(`${menu}<h1>Outlet</h1><p>Last season's stock at lower prices.</p>`);
      if (path === "/outlet/search")
        return html(
          `${menu}<h1>Search</h1><p>No results for “${(url.searchParams.get("q") ?? "").replace(/[<>&"]/g, "")}”.</p>`,
        );
      if (path === "/outlet/phones") {
        const second = url.searchParams.get("page") === "2";
        const shown = second ? outlet.slice(6) : outlet.slice(0, 6);
        return html(`${menu}<h1>Phones${second ? " (page 2 of 2)" : " (page 1 of 2)"}</h1>
          ${shown.map((p) => `<div><a href="/outlet/p/${p.id}">${p.name}</a> <span>${p.price}</span></div>`).join("")}
          ${second ? `<a href="/outlet/phones">‹ Previous page</a>` : `<a href="/outlet/phones?page=2">Next page ›</a>`}`);
      }
      if (path === "/outlet/laptops" || path === "/outlet/deals")
        return html(
          `${menu}<h1>${path.endsWith("deals") ? "Deals" : "Laptops"}</h1><p>Nothing here right now.</p>`,
        );
      const product = outlet.find((p) => path === `/outlet/p/${p.id}`);
      if (product)
        return html(
          `${menu}<h1>${product.name}</h1><p>Outlet price: ${product.price}</p><button>Buy now</button>`,
        );
    }
    // A results page whose search box still holds the last search (as search engines' do), and a rich-text box.
    if (url.pathname === "/prefilled") {
      return html(`<input type="search" id="q" aria-label="Search" value="vivo y19s" style="width:400px;font-size:16px">
        <div id="note" contenteditable="true" aria-label="Note" style="width:400px;height:40px;border:1px solid #999">Old note</div>`);
    }
    // A form whose text box, tick box and "Pay now" button sit one Tab apart. Sending it (Enter in the box, or Space
    // on the focused button) goes to /sent.
    if (url.pathname === "/form") {
      return html(`<form action="/sent" method="get">
        <input type="text" name="note" aria-label="Note">
        <input type="checkbox" name="gift" id="gift" aria-label="Gift wrap">
        <input type="submit" value="Pay now">
      </form>`);
    }
    if (url.pathname === "/sent")
      return html(`<h1>Form sent</h1><p>${url.search.replace(/[<>&"]/g, "")}</p>`);
    // Payment boxes as sites really write them: a card number in a plain text box, one named by its autocomplete
    // token, a password a "show password" switch turned into plain text, and a name that is no secret.
    if (url.pathname === "/pay") {
      return html(`<input type="text" id="card" name="cardnumber" aria-label="Card number" value="4242 4242 4242 4242"><br>
        <input type="text" id="billing" autocomplete="billing cc-number" aria-label="Billing card" value="5555 5555 5555 4444"><br>
        <input type="text" id="pass" autocomplete="current-password" aria-label="Account password" value="hunter2"><br>
        <input type="text" id="holder" aria-label="Name on card" value="Ada Lovelace">`);
    }
    // What the page can tell about the browser: whether it says it is automated, and the name it gives.
    if (url.pathname === "/whoami") {
      return html(`<p id="who"></p><script>document.getElementById("who").textContent =
        "webdriver=" + navigator.webdriver + " agent=" + navigator.userAgent;</script>`);
    }
    // An ordinary article that only looks like a human check: it talks about security checks at length and carries
    // an invisible reCAPTCHA and a hidden captcha field, as many sign-in and contact pages do.
    if (url.pathname === "/article") {
      return html(`<h1>Getting through the airport security check</h1>
        <p>${"Arrive early, keep liquids apart, and take your laptop out at the security check. ".repeat(60)}</p>
        <iframe src="/recaptcha/api2/anchor?size=invisible" title="reCAPTCHA" width="256" height="60"></iframe>
        <input type="hidden" id="captcha_token" value="x">
        <button onclick="document.title='read more'">Read more</button>`);
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
