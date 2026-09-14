// Anivax Megavid proxy — Cloudflare Worker
//
// Resolves a Megavid embed to a playable HLS stream + soft-subtitle tracks
// and proxies the media requests through Cloudflare's edge so the browser can
// actually load them (Megavid only allows CORS from its own origin).
//
// Free-tier friendly (100k requests/day):
//   - /source resolves an episode with a single request (cached 1h).
//   - /proxy returns bytes with strong Cache-Control, so Cloudflare's CDN and
//     the browser cache every segment. Re-watching an episode costs ~0
//     requests (served straight from edge/browser cache), only first-time
//     playback uses one request per segment.
//
// Endpoints (all GET):
//   /source?idType=mal|ani&id=<id>&ep=<n>&lang=sub
//       -> { status:"ok", source:"<m3u8>", tracks:[{file,label}], meta:{...} }
//          or { status:"error", message } with a 502.
//   /proxy?url=<encoded target>&referer=<encoded referer>
//       -> bytes of the target resource with permissive CORS + rewritten
//          relative URLs (for .m3u8 playlists so segments also go through us).

const MEGAVID_BASE = "https://megavid.buzz";

const DEFAULT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Keep these safe/fixed — they identify an ordinary browser embed, not a bot.
function edgeFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Referer: opts.referer || MEGAVID_BASE,
      Origin: opts.origin || MEGAVID_BASE,
      Accept: opts.accept || "*/*",
      ...(opts.headers || {}),
    },
  });
}

// A stalled upstream must never hang inside a Worker — return null on timeout
// instead of burning the wall-clock budget on a dead CDN.
function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return edgeFetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
function corsHeaders(extra = {}) {
  return { ...DEFAULT_HEADERS, ...extra };
}

// ---- /source ---------------------------------------------------------------
async function handleSource(request, url) {
  const idType = url.searchParams.get("idType") || "mal";
  const id = url.searchParams.get("id");
  const ep = url.searchParams.get("ep") || "1";
  const lang = url.searchParams.get("lang") || "sub";
  if (!id) {
    return new Response(
      JSON.stringify({ status: "error", message: "Missing id parameter" }),
      { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }

  const attempts = [
    `/${idType}/${encodeURIComponent(id)}/${ep}/${lang}/source`,
  ];
  // Fall back to the other id namespace when the requested one 404s.
  const otherType = idType === "mal" ? "ani" : "mal";
  attempts.push(`/${otherType}/${encodeURIComponent(id)}/${ep}/${lang}/source`);

  let lastError = null;
  for (const path of attempts) {
    try {
      const res = await fetchT(MEGAVID_BASE + path, {
        referer: MEGAVID_BASE + "/",
        accept: "application/json",
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.status === "ok" && body.source) {
        const tracks = Array.isArray(body.tracks) ? body.tracks : [];
        return new Response(
          JSON.stringify({
            status: "ok",
            source: body.source,
            tracks: tracks.map((t) => ({
              file: t.file,
              label: t.label || (t.lang ? t.lang.toUpperCase() : "English"),
              lang: t.lang || "en",
            })),
            meta: {
              idType,
              id,
              episode: parseInt(ep, 10) || 1,
              lang,
              name: body.name || null,
            },
          }),
          {
            headers: corsHeaders({
              "Content-Type": "application/json",
              // Same episode resolves identically — let edge+browser cache it.
              "Cache-Control": "public, max-age=3600",
            }),
          },
        );
      }
      lastError = body && body.message ? body.message : `HTTP ${res.status}`;
      // retryable 503 means busy source — try the other id namespace before failing.
      if (res.status === 404) continue;
    } catch (e) {
      lastError = e.message;
    }
  }
  return new Response(
    JSON.stringify({
      status: "error",
      message: lastError || "Could not resolve episode source",
      retryable: true,
    }),
    { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
  );
}

// ---- /proxy -----------------------------------------------------------------
// Fetches a resource (m3u8 playlist, .ts/.m4s segment, .vtt subtitle, AES key)
// with the Referer/Origin headers Megavid expects and returns it to the browser
// with `Access-Control-Allow-Origin: *`. For HLS playlists it rewrites every
// relative URI inside so subsequent segment requests also route through us.
async function handleProxy(request, url) {
  const target = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") || MEGAVID_BASE + "/";
  if (!target) {
    return new Response("Missing url parameter", { status: 400, headers: corsHeaders() });
  }
  // Only ever fetch from the known video CDNs to avoid becoming an open proxy.
  const ALLOWED_HOSTS = [
    "megavid.buzz",
    "acek-cdn.com",
    "dramiyos-cdn.com",
    "anizara.store",
    "vivibebe.site",
    "bibiemb.xyz",
    // vivibebe (bibiemb) segmentleri ByteDance'in p16-ad-sg.ibyteimg.com CDN'inden
    // gelir. Segmentler "/obj/..." altında olduğundan /public/stream imzası
    // tutmaz; host'u açıkça izinlemek gerekir.
    "ibyteimg.com",
    "byteimg.com",
    // MegaPlay/Anikoto CDN ailesi. CORS'u açık olanlardan (ncdn.imgnex.top vb.)
    // tarayıcı doğrudan çeker; referer-şartı koyanlardan (megap.mikora.top vb.)
    // /proxy üzerinden geçer. Front-hostlar embed'e göre değiştiğinden alt
    // alanlar suffix eşleşmesiyle yakalanır.
    "imgnex.top",
    "akirax.buzz",
    "nexabloom.top",
    "mikora.top",
    "norami.top",
    "shiora.top",
    "shiora.site",
    // MegaPlay'in bazı bölümleri segmentleri PNG-maskeli TS olarak ByteDance
    // CDN'inden (p16/p19-ad-site-sign-sg.tiktokcdn.com) sunar — Megavid'in
    // maskesinden farksız; stripPngMask yolu üzerinden geçer (isMegapayStream
    // path imzası tiktokcdn yollarına uymaz, o yüzden doğru şekilde hassaslaşır).
    "tiktokcdn.com",
    "tiktokcdn.in",
  ];
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("Invalid url parameter", { status: 400, headers: corsHeaders() });
  }
  const host = targetUrl.hostname;
  // otakuvid's masked CDN rotates random front-hosts per-embed (e.g.
  // eTOjdo3Yv1iw.wcfpc8vpy5udbwh.cfd, WPvsAhSVL0YO.mindbodywellness.space,
  // m5QqjwpATPzb.infrastructureportal.site ...). We can't enumerate them, so
  // instead of trusting the host we accept streams whose path carries the
  // otakuvid HLS signature (/hls3/ or /hls/) — playlists, segments and
  // iframe/variant lists all live under those paths. Same for the
  // bibiemb/vivibebe direct-master family (/public/stream/.../master.m3u8).
  const isOtakuvidStream = /\/hls3?\//i.test(targetUrl.pathname) ||
    /^\/public\/stream\//i.test(targetUrl.pathname);
  // MegaPlay CDN ailesi: gerçek MPEG-TS segmentleri .png uzantısıyla gelir
  // (PNG maskesi YOK — strip gerekmez). Megavid'deki tamponlama riskini
  // almamak için bunlar da doğrudan akış yapar. Measurement-imkânsız*
  // (*host yerine path): ön-hostlar embed'e göre döner (megap.norami.top,
  // ncdn.imgnex.top, bb.akirax.buzz, fetch.nexabloom.top ...) — hepsini
  // tek tek izinlemek kırılgan. Ortak imza: /anime/{32hex}/{32hex}/… veya
  // /{32hex}/{32hex}/… (master, varyant, segment, altyazı hepsi bu ağaçta).
  const isMegapayStream = /^\/(anime\/)?[0-9a-f]{32}\/[0-9a-f]{32}\//i.test(targetUrl.pathname);
  const hostAllowed =
    ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h)) ||
    isOtakuvidStream ||
    isMegapayStream;
  if (!hostAllowed) {
    return new Response("Host not allowed", { status: 403, headers: corsHeaders() });
  }

  const isPlaylistByPath = targetUrl.pathname.endsWith(".m3u8") || targetUrl.pathname.endsWith(".txt");
  const isSub = targetUrl.pathname.endsWith(".vtt");

  // Megavid's CDN front-pads every TS segment with a fake 1x1 PNG header
  // (a browser-embed obfuscation trick). HLS.js can't demux those bytes, so we
  // strip the PNG shell and hand back the real MPEG-TS payload.
  function stripPngMask(buf) {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf.length < 8 ||
      buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
      buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a
    ) {
      return buf;
    }
    // Walk the chunk list until IEND (type 49 45 4E 44) is found; everything
    // after its 4-byte CRC is the real segment data.
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
      const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
      if (type === "IEND") {
        const payloadEnd = off + 8 + len + 4; // after CRC
        return buf.subarray(payloadEnd);
      }
      off += 8 + len + 4;
    }
    return buf;
  }

  try {
    // Match the Origin header to the referer's origin — otakuvid's CDN only
    // serves requests whose Origin/Referer is otakuvid.online; megavid's CDN
    // expects megavid.buzz. Sending a fixed megavid origin made otakuvid
    // requests intermittently hang or get rejected.
    let origin;
    try { origin = new URL(referer).origin; } catch { origin = MEGAVID_BASE; }
    const res = await fetchT(targetUrl.href, {
      referer: referer,
      origin: origin,
      accept: isPlaylistByPath
        ? "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
        : "*/*",
    });

    if (!res.ok) {
      return new Response(res.body, {
        status: res.status,
        headers: corsHeaders({ "Content-Type": res.headers.get("Content-Type") || "text/plain" }),
      });
    }

    const contentType = res.headers.get("Content-Type") || "application/octet-stream";
    const base = new URL(request.url);

    // Detect playlists by content when the CDN masks the extension
    // (master.txt, .urlse, random suffixes). If it looks like an m3u8, treat it
    // as one regardless of path/extension.
    let isPlaylist = isPlaylistByPath;
    let playlistText = null;
    if (!isPlaylist && /text|mpegurl|playlist/i.test(contentType)) {
      const probe = await res.clone().text();
      isPlaylist = probe.trim().startsWith("#EXTM3U");
      if (isPlaylist) playlistText = probe;
    }

    if (isPlaylist) {
      // Rewrite playlist lines: absolute/relative segment + key URIs become
      // /proxy?url=<encoded>&referer=<encoded>. Also rewrite URI="..." inside
      // tag lines (e.g. #EXT-X-I-FRAME-STREAM-INF) so iframe playlists flow
      // through the proxy too.
      const proxify = (u) =>
        base.origin + "/proxy?url=" + encodeURIComponent(u) + "&referer=" + encodeURIComponent(referer);
      const text = playlistText !== null ? playlistText : await res.text();
      const rewritten = text
        .split("\n")
        .map((line) => {
          const l = line.trim();
          if (!l) return line;
          if (l.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
            return l.replace(/URI="([^"]+)"/g, (m, uri) => {
              try { return `URI="${proxify(new URL(uri, targetUrl.href).href)}"`; }
              catch { return m; }
            });
          }
          if (l.startsWith("#")) return line;
          let abs;
          try {
            abs = new URL(l, targetUrl.href);
          } catch {
            return line;
          }
          return line.replace(l, proxify(abs.href));
        })
        .join("\n");
      return new Response(rewritten, {
        headers: corsHeaders({
          "Content-Type": contentType,
          // Playlists are VOD and identical for repeat views — edge-cache them
          // so re-watching an episode doesn't re-request the manifest.
          "Cache-Control": "public, max-age=3600",
        }),
      });
    }

    // Pass through raw bytes for segments / subtitles / keys. These are the
    // big cost-driver: a single episode is ~200 segments. They are immutable
    // VOD files, so cache them hard (7 days) in the browser AND on Cloudflare's
    // edge. First watch = ~200 requests; every re-watch = 0 requests served
    // straight from cache, which is what keeps us far under the 100k/day cap.
    const oneDay = 86400;
    const cacheSecs = isSub ? oneDay : 7 * oneDay;
    const segHeaders = corsHeaders({
      "Content-Type": isSub ? "text/vtt; charset=utf-8" : contentType,
      "Cache-Control": `public, max-age=${cacheSecs}, immutable`,
    });

    // otakuvid segments are real MPEG-TS (no PNG mask) and can be slow — the
    // Death Note test shipped a 2.9MB segment that took 30s+ on a busy CDN.
    // Buffering the whole body (`arrayBuffer`) blew past the Worker wall-clock
    // budget and the stream never got a response. Streaming straight through
    // avoids that: bytes flow chunk-by-chunk, no buffering limit. Megavid
    // segments carry the PNG mask, so those still buffer + strip first.
    if (isOtakuvidStream || isMegapayStream) {
      return new Response(res.body, { headers: segHeaders });
    }

    const buffer = await res.arrayBuffer();
    const payload = stripPngMask(new Uint8Array(buffer));
    return new Response(payload, { headers: segHeaders });
  } catch (e) {
    return new Response("Proxy error: " + e.message, {
      status: 502,
      headers: corsHeaders(),
    });
  }
}

// ---- /translate --------------------------------------------------------------
// Proxies an OpenAI-compatible chat completion (Z.AI / GLM) request so the
// browser never has to send the user's API key to a third-party origin directly
// (CORS + key hygiene). The user's own key travels from their browser to our
// worker over HTTPS and is only used for this one upstream call.
async function handleTranslate(request, url) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
  }
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body.apiKey !== "string" || !body.apiKey) {
    return new Response(
      JSON.stringify({ error: "Missing apiKey" }),
      { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
  const apiKey = body.apiKey.trim();
  const model = typeof body.model === "string" && body.model ? body.model : "glm-4.7-flash";
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const text = typeof body.text === "string" ? body.text : null;
  // GLM "thinking" mode slows responses dramatically for batch subtitle work;
  // default to disabled, allow explicit override from the client.
  const thinking = body.thinking && typeof body.thinking === "object" ? body.thinking : { type: "disabled" };
  const maxTokens = Number.isFinite(body.maxTokens) ? body.maxTokens
    : (typeof body.max_tokens === "number" ? body.max_tokens : 4096);
  const responseFormat = body.responseFormat && typeof body.responseFormat === "object" ? body.responseFormat
    : (typeof body.response_format === "object" ? body.response_format : undefined);
  if (!messages && !text) {
    return new Response(
      JSON.stringify({ error: "Missing messages or text" }),
      { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }

  // Build the upstream payload: prefer explicit messages, else wrap plain text.
  const upstreamMessages = messages || [{ role: "user", content: text }];

  const upstream = await fetchT("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      // Z.AI's public API is CORS-open for authorized calls; the worker still
      // passes a browser-ish UA so nothing upstream flags it.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    },
    body: JSON.stringify({
      model,
      messages: upstreamMessages,
      temperature: 0.3,
      max_tokens: maxTokens,
      thinking,
      do_sample: false,
      ...(responseFormat ? { response_format: responseFormat } : {})
    }),
  }, 90000);

  if (!upstream.ok) {
    let msg = "Upstream " + upstream.status;
    try { const j = await upstream.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return new Response(
      JSON.stringify({ error: msg, upstreamStatus: upstream.status }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
  const json = await upstream.json().catch(() => null);
  if (!json || !json.choices || !json.choices[0]) {
    return new Response(
      JSON.stringify({ error: "Unexpected upstream response" }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
  const content = json.choices[0].message && json.choices[0].message.content;
  return new Response(
    JSON.stringify({ content: typeof content === "string" ? content : JSON.stringify(content) }),
    { headers: corsHeaders({ "Content-Type": "application/json" }) },
  );
}

// ---- /anineko-source ---------------------------------------------------------
// Resolves an Anineko episode (which proxies videos through its own Cloudflare
// worker, vibevibe.workers.dev, with wide-open CORS) to a directly playable HLS
// stream. The browser then fetches segments straight from the CDN — our worker
// only pays ~2 requests per episode instead of ~325 for Megavid.
//
// Flow: anineko search (by title) -> watch page -> otakuvid.online embed ->
// packed JS -> m3u8 URL. Returns { status:"ok", source:"<m3u8>", tracks:[...],
// meta:{...} }.

const ANINEKO_BASE = "https://anineko.to";
const OTAKUVID_BASE = "https://otakuvid.online";

// Dean Edwards packer decoder — otakuvid embeds ship their player config
// packed this way. The k-list itself can contain "'".split('-... string mash
// fragments (the dash in "-cdn.com" is re-inserted at runtime via .split()),
// so we split the trailing ',RADIX,COUNT,'KSTR' args from the right instead of
// using one greedy regex over the whole script.
function unpackPacker(packed) {
  const endIdx = packed.lastIndexOf("))");
  if (endIdx < 0) return null;
  const openIdx = packed.lastIndexOf("}(", endIdx);
  if (openIdx < 0) return null;
  // Everything after "}(" up to the trailing "))" is: 'CODE',radix,count,'KSTR
  const args = packed.slice(openIdx + 2, endIdx);
  const codeM = args.match(/^'([\s\S]*?)',(\d+),(\d+),'([\s\S]*)$/);
  if (!codeM) return null;
  const [, code, radix, count, kStr] = codeM;
  const k = kStr.split("|");
  const base = parseInt(radix, 10);
  let out = code;
  for (let i = count - 1; i >= 0; i--) {
    out = out.replace(new RegExp("\\b" + i.toString(base) + "\\b", "g"), k[i] || i.toString(base));
  }
  // Rejoin `.split('-'...)` string mashing: "foo.dramiyos'.split('-cdn.com" -> "foo.dramiyos-cdn.com",
  // and ".cfd"-style mash: "host'.split('.cfd/path" -> "host.cfd/path".
  out = out.replace(/([A-Za-z0-9.]+)'\.split\('([A-Za-z0-9./?=&:-]+)/g, "$1$2");
  return out;
}

// Shared extraction for the otakuvid-family embed pages (otakuvid.online/embed/<id>
// and otakuhg.site/e/<id>). Both ship their player config inside a Dean Edwards
// packed script; the hlsN entries carry the playable masked-CDN master.
async function resolvePackedEmbed(embedUrl, pageUrl) {
  if (!embedUrl) return null;
  const embedRes = await fetchT(embedUrl, { referer: pageUrl });
  const embedHtml = await embedRes.text();
  const packerStart = embedHtml.indexOf("eval(function(p,a,c,k,e,d)");
  const newline = embedHtml.indexOf("\n", packerStart);
  if (packerStart < 0 || newline < 0) return null;
  const packed = embedHtml.slice(packerStart, newline);
  const decoded = unpackPacker(packed);
  if (!decoded) return null;
  const linkMatch = [...decoded.matchAll(/"hls[0-9]":"([^"]+)"/g)].map((m2) => m2[1]);
  // Prefer the masked-CDN master (playlist = master.txt) that serves directly;
  // fall back to the tokenized -cdn.com link, then to whatever is present.
  const masked =
    linkMatch.find((l) => /master\.txt/i.test(l) && /\.(?:cfd|space|site|top)\b/i.test(l)) ||
    linkMatch.find((l) => /master\.txt/i.test(l) || /wcfpc8/i.test(l));
  const cdn = linkMatch.find((l) => l.includes("acek-cdn.com") || l.includes("-cdn.com"));
  return masked || cdn || linkMatch[0] || null;
}

// bibiemb family: the data-video URL is a VibePlayer page (vivibebe.site/<hash>)
// whose HTML embeds the real master at /public/stream/<hash>/master.m3u8. A few
// older direct-master hosts (bibiemb.xyz/<hash>) return the playlist outright.
// We handle both and strip any ?sub= hint (the subtitle VTT is attached
// separately on the frontend).
async function resolveBibiemb(dataVideoUrl, pageUrl) {
  if (!dataVideoUrl) return null;
  const clean = dataVideoUrl.split("?")[0];
  try {
    const res = await fetchT(clean, { referer: pageUrl });
    if (!res.ok) return null;
    const ct = res.headers.get("Content-Type") || "";
    if (/mpegurl|mpeg/i.test(ct)) return clean;
    const body = await res.text().catch(() => "");
    if (body.trim().startsWith("#EXTM3U")) return clean;
    // VibePlayer page → extract the absolute master.m3u8 link.
    const master = body.match(/https?:\/\/[^"'\s>]*master\.m3u8[^"'\s>]*/i);
    if (master) return master[0].split("?")[0];
  } catch (e) { /* fall through */ }
  return null;
}

async function handleAninekoSource(request, url) {
  let slug = url.searchParams.get("slug");
  const title = url.searchParams.get("title");
  const ep = url.searchParams.get("ep") || "1";
  // "source" opts into resolving only ONE server family; "sources" takes a
  // comma-separated subset. The worker resolves EXACTLY those families — any
  // family a user/admin disabled is never fanned out to, and a specific pick
  // only ever touches that one server.
  const VALID = ["otakuhg", "bibiemb", "otakuvid"];
  const rawOnly = url.searchParams.get("source");
  const rawSources = url.searchParams.get("sources");
  let wantSources = null;
  if (rawOnly) {
    wantSources = [rawOnly];
  } else if (rawSources) {
    wantSources = rawSources.split(",").map(s => s.trim()).filter(Boolean);
  }
  if (wantSources) {
    if (wantSources.length === 0 || wantSources.some(s => !VALID.includes(s))) {
      return new Response(
        JSON.stringify({ status: "error", message: "Unknown source", retryable: false }),
        { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
  }
  if (!slug && !title) {
    return new Response(
      JSON.stringify({ status: "error", message: "Missing slug or title parameter" }),
      { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }

  try {
    // 0) No slug given -> resolve it via the Anineko search API. Prefer an exact
    //    title match; otherwise take the first result.
    if (!slug) {
      const searchRes = await fetchT(
        `${ANINEKO_BASE}/ajax/search?q=${encodeURIComponent(title)}`,
        { referer: ANINEKO_BASE + "/", accept: "application/json" },
      );
      const searchJson = await searchRes.json().catch(() => null);
      const results = searchJson && Array.isArray(searchJson.results) ? searchJson.results : [];
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
      const want = norm(title);
      const exact = results.find((r) => norm(r.title) === want);
      const chosen = exact || results[0];
      if (!chosen || !chosen.url) {
        return new Response(
          JSON.stringify({ status: "error", message: "Anime not found on Anineko", retryable: false }),
          { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
        );
      }
      slug = chosen.url.replace(/^\/watch\//, "").replace(/\/.*$/, "");
    }

    // 1) Fetch the Anineko watch page and collect every server button it
    //    exposes (data-video=...), grouped into the three families the site
    //    actually uses: bibiemb, otakuhg and otakuvid.
    const pageUrl = `${ANINEKO_BASE}/watch/${encodeURIComponent(slug)}/ep-${ep}`;
    const pageRes = await fetchT(pageUrl, { referer: ANINEKO_BASE + "/" });
    const pageHtml = await pageRes.text();
    const dataVideos = [...pageHtml.matchAll(/data-video="([^"]+)"/g)].map((m) => m[1]);

    // Her kaynak ailesi için watch sayfasında İKİ düğme vardır:
    //   1) SOFT (clean video + VTT overlay): URL'de `?caption_N=<.vtt>` /
    //      `?sub=<.vtt>` param var → istediğimiz anayol (alt yazı VTT'den gelir).
    //   2) PLAIN: parametresiz → hardsub encode olabilir (alttiyazi çekilmiş).
    // `pick` her zaman SOFT varyantı seçer; soft yoksa ancak ilk/plain'e döner.
    const isSoftUrl = (u) => /\?(caption_?[0-9]*=|sub=|sub_|c[0-9]_|s[0-9]_)/.test(u);
    const pick = (hostPattern, hint) => {
      const family = dataVideos.filter((u) => hostPattern.test(u));
      if (family.length === 0) return null;
      const hinted = hint ? family.find((u) => u.includes(hint)) : null;
      const soft = family.find(isSoftUrl) || hinted;
      const chosen = soft || family[0];
      return { url: chosen, soft: !!soft };
    };

    const bibiembPick = pick(/^https:\/\/vivibebe\.site\//i, "sub=");
    const otakuhgPick = pick(/^https:\/\/otakuhg\.site\/e\//i, null);
    const otakuvidPick = pick(/^https:\/\/otakuvid\.online\/embed\//i, "caption_");
    const input = {
      bibiemb: { url: bibiembPick && bibiembPick.url, soft: !!(bibiembPick && bibiembPick.soft) },
      otakuhg: { url: otakuhgPick && otakuhgPick.url, soft: !!(otakuhgPick && otakuhgPick.soft) },
      otakuvid: { url: otakuvidPick && otakuvidPick.url, soft: !!(otakuvidPick && otakuvidPick.soft) },
    };

    // 2) Family resolvers, keyed exactly like the source labels the UI sends.
    //    When `only` (a ?source= param) is set we resolve a single family — the
    //    user's explicit choice. Resolving an unselected server would leak that
    //    request out, so unselected families are never touched.
    const resolvers = {
      bibiemb: () => resolveBibiemb(input["bibiemb"].url, pageUrl),
      otakuhg: () => resolvePackedEmbed(input["otakuhg"].url, pageUrl),
      otakuvid: () => resolvePackedEmbed(input["otakuvid"].url, pageUrl),
    };
    const pending = wantSources
      ? Object.fromEntries(wantSources.map((k) => [k, resolvers[k]()]))
      : {
          otakuhg: resolvers["otakuhg"](),
          bibiemb: resolvers["bibiemb"](),
          otakuvid: resolvers["otakuvid"](),
        };
    const resolved = {};
    for (const [k, p] of Object.entries(pending)) {
      resolved[k] = await p.catch(() => null);
    }
    const bibiemb = resolved["bibiemb"];
    const otakuhg = resolved["otakuhg"];
    const otakuvid = resolved["otakuvid"];

    // 3) Subtitle tracks from the watch page (caption_N VTT links). Every
    //    family's softsub variant references the same cdn.anizara.store VTTs, so
    //    the tracks below apply to each resolved source.
    const tracks = [];
    const seen = new Set();
    for (const m2 of pageHtml.matchAll(/caption_[0-9]=([^&"']+\.vtt)[^"']*&sub_[0-9]=([^&"']+)/g)) {
      const file = m2[1];
      if (seen.has(file)) continue;
      seen.add(file);
      tracks.push({ file, label: m2[2], lang: "en" });
    }

    // Sıralama: SOFT (VTT'li kesin çizgi) varyantlar önce → hardsub-protected
    // encode'lara takılmak yerine alt yazısı VTT'den gelen clean kaynak seçilir.
    // Aralarında eşitse hızlılık sırası korunur (otakuhg → bibiemb → otakuvid).
    const sources = [
      { key: "otakuhg", name: "Otakuhg", source: otakuhg, soft: input["otakuhg"].soft },
      { key: "bibiemb", name: "Bibiemb", source: bibiemb, soft: input["bibiemb"].soft },
      { key: "otakuvid", name: "Otakuvid", source: otakuvid, soft: input["otakuvid"].soft },
    ]
      .filter((s) => s.source)
      .sort((a, b) => (b.soft ? 1 : 0) - (a.soft ? 1 : 0));

    if (sources.length === 0) {
      return new Response(
        JSON.stringify({ status: "error", message: "No playable source found", retryable: false }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        source: sources[0].source,
        sources,
        tracks,
        meta: {
          slug,
          episode: parseInt(ep, 10) || 1,
          lang: "sub",
          sourceName: sources.map((s) => s.name).join(" + "),
        },
      }),
      { headers: corsHeaders({ "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }) },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: "error", message: e.message, retryable: true }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
}


// ---- /megapay-source -------------------------------------------------------
// Anikoto + MegaPlay ağı üzerinden tek istekte çözülür: anikoto.site araması
// (title → iş içi kimlik), /series/{id} API'si (bölüm → episode_embed_id),
// megaplay s-2 embed sayfası (embed id → data-id/media id), ve getSourcesNew
// (media id → m3u8 + EN softsub VTT). CDN host'ları (megap.*, bb.akirax,
// fetch.nexabloom, tiktokcdn...) referer/Origin kontrolü yaptığından tarayıcı
// bunları DOĞRUDAN çekemez; frontend `direct:false` görünce m3u8+segment+VTT'yi
// /proxy üzerinden ister (segmentler akış yapar / maskeli olanlar strip edilir).
// Sonuç: çözümleme 1 istek, oynatma Megavid'in ~325 istek yükünden uzak.
//
// Gets: /megapay-source?title=<title>&ep=<n>
//   -> { status:"ok", source:"<m3u8>", direct, tracks:[{file,label,lang}], meta }
//      direct=false → frontend kaynakları /proxy'den çeker.

const ANIKOTO_SITE = "https://anikototv.to";
const ANIKOTO_API = "https://anikotoapi.site";
const MEGAPLAY_BASE = "https://megaplay.buzz";

// ---- /archive-source ------------------------------------------------------
// archive.org'da ham (RAW, gömülüsüz) bölüm MP4'ü + ayrı altyazı dosyası bulur.
// Gets: /archive-source?title=<title>&ep=<n>
//  -> { status:"ok", source:"<mp4>", direct:true, tracks:[{file,label,lang}], meta }
// Zincir: advancedsearch (1) → metadata (1-3) → seçim. Tarayıcı MP4'ü
// CORS-açık archive.org'dan DİREKT çeker (ACAO:*, range destekli) — worker'a
// segment yükü YOK, bölüm başı maliyet 1-3 çözümleme isteği. Altyazı yoksa
// istemci AI çeviriyi ham videonun üstüne koyar (ayrı katman).
const ARCHIVE_BAD_WORDS = ["reaction", "review", "amv", "pv", "trailer", "teaser", "opening", "ending", "op ", "ed ", " ost", "cover", "clip", "moment", "top 10", "vs ", "amv)", "(amv", "mashup", "nightcore"];
// Gömülü (hardsub) altyazılı gruplar: video ham değildir — en sona atılır,
// meta.subBurned ile işaretlenir (istemci ham olanı tercih eder).
const ARCHIVE_HARDSUB_GROUPS = ["pahe", "subsplease", "horriblesubs"];
function archiveEpMatch(text, ep) {
  const t = " " + String(text || "").toLowerCase().replace(/[_\.\-]+/g, " ") + " ";
  const n = String(ep);
  const nz = n.length === 1 ? "0" + n : n;
  const pats = [
    new RegExp("(episode|ep|e)\\s*0?" + n + "\\b"),
    new RegExp("[\\s\\[\\(\\-]0?" + nz + "[\\s\\]\\)\\-\\.]"),
    new RegExp("\\bs" + "\\d{1,2}" + "e0?" + n + "\\b"),
  ];
  return pats.some((rx) => rx.test(t));
}
function archiveScore(item, ep) {
  const title = String(item.title || "");
  const id = String(item.identifier || "");
  const blob = (title + " " + id).toLowerCase();
  if (ARCHIVE_BAD_WORDS.some((w) => blob.includes(w))) return -1000;
  if (!archiveEpMatch(title + " " + id, ep)) return -1000;
  let s = 0;
  if (id.includes("erai")) s += 50;              // ham + multisub garantisi
  if (/1080p/i.test(blob)) s += 20;
  else if (/720p/i.test(blob)) s += 10;
  else if (/480p/i.test(blob)) s += 5;
  if (/multi[\s_-]?sub/i.test(blob)) s += 15;
  if (/web[\s_-]?dl|bluray|bd /i.test(blob)) s += 10;
  const burned = ARCHIVE_HARDSUB_GROUPS.find((g) => blob.includes(g)) || null;
  if (burned) s -= 40; // gömülü altyazı: ham değil, ancak hiç yoksa oynar
  return { score: s, burned };
}
async function handleArchiveSource(request, url) {
  const title = url.searchParams.get("title");
  const epRaw = url.searchParams.get("ep") || "1";
  const ep = parseInt(epRaw, 10) || 1;
  if (!title) {
    return new Response(
      JSON.stringify({ status: "error", message: "Missing title parameter" }),
      { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const titleNorm = norm(title);
  if (!titleNorm) {
    return new Response(
      JSON.stringify({ status: "error", message: "Empty title", retryable: false }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
  try {
    // 1) archive.org gelişmiş arama (anahtarsız, herkese açık).
    const q = "title:(" + titleNorm + ") AND mediatype:movies";
    const searchRes = await fetchT(
      "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(q) +
      "&fl[]=identifier,title,date&rows=40&output=json",
      { accept: "application/json, */*" }, 15000);
    const searchJson = await searchRes.json().catch(() => null);
    const docs = (searchJson && searchJson.response && Array.isArray(searchJson.response.docs))
      ? searchJson.response.docs : [];
    if (!docs.length) {
      return new Response(
        JSON.stringify({ status: "error", message: "Nothing on archive.org", retryable: false }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
    // Başlık benzerliği filtresi: arşiv araması gevşek eşleşir; seri adının
    // ilk iki anlamlı kelimesi adayda geçmeli (yanlış seriyi elemek için).
    const keywords = titleNorm.split(" ").filter((w) => w.length > 2).slice(0, 3);
    const scored = [];
    for (const d of docs) {
      const blob = norm((d.title || "") + " " + (d.identifier || ""));
      if (!keywords.every((k) => blob.includes(k))) continue;
      const r = archiveScore(d, ep);
      if (r.score > -1000) scored.push({ d, s: r.score, burned: r.burned });
    }
    scored.sort((a, b) => b.s - a.s);
    if (!scored.length) {
      return new Response(
        JSON.stringify({ status: "error", message: "No matching episode on archive.org", retryable: false }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
    // 2) En iyi 3 adayın metadata'sına bak: en büyük MP4 + EN srt öncelikli.
    for (const { d, burned } of scored.slice(0, 3)) {
      try {
        const metaRes = await fetchT("https://archive.org/metadata/" + encodeURIComponent(d.identifier),
          { accept: "application/json, */*" }, 15000);
        const meta = await metaRes.json().catch(() => null);
        const files = (meta && Array.isArray(meta.files)) ? meta.files : [];
        const mp4s = files
          .filter((f) => f && typeof f.name === "string" && /\.mp4$/i.test(f.name) &&
            !/sample|preview|trailer/i.test(f.name) && Number(f.size || 0) > 20 * 1024 * 1024)
          .sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
        if (!mp4s.length) continue;
        // En büyük MP4'ü al (bölümün kendisi; küçükler klip/parça olur).
        const mp4 = mp4s[0];
        const subs = files.filter((f) => f && typeof f.name === "string" && /\.(srt|vtt|ass)$/i.test(f.name));
        const engFirst = subs.sort((a, b) => {
          const ae = /eng|english/i.test(a.name) ? 0 : 1;
          const be = /eng|english/i.test(b.name) ? 0 : 1;
          return ae - be;
        });
        const dl = "https://archive.org/download/" + encodeURIComponent(d.identifier) + "/";
        const tracks = engFirst.slice(0, 4).map((f) => {
          const lang = /eng|english/i.test(f.name) ? "en" : (/jpn|japan/i.test(f.name) ? "jp" : "");
          return { file: dl + encodeURIComponent(f.name), label: f.name.replace(/\.[^.]+$/, "").slice(0, 60), lang };
        });
        return new Response(JSON.stringify({
          status: "ok",
          source: dl + encodeURIComponent(mp4.name),
          direct: true, // tarayıcı CORS-açık archive.org'dan direkt çeker
          tracks,
          meta: {
            identifier: d.identifier,
            title: d.title || "",
            episode: ep,
            sourceName: "Archive.org",
            size: Number(mp4.size || 0),
            subBurned: burned || null, // gömülü altyazılı grupsa adı (ham değil)
          },
        }), { headers: corsHeaders({ "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }) });
      } catch (e) { /* sıradaki aday */ }
    }
    return new Response(
      JSON.stringify({ status: "error", message: "No playable file on archive.org", retryable: true }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: "error", message: e.message, retryable: true }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
}

// ---- MegaPlay `enc` çözümü ------------------------------------------------
// getSourcesNew artık `{ sources:{file} }` yerine `{ server, enc }` dönüyor;
// `enc` = base64url(AES-256-CBC(utf8JSON, key, iv)), plaintext `{"file":"..."}`.
// Key/IV newclient.min.js içinden kazınır (sürüm değişimine dayanıklı),
// kazıma başarısızsa sabit fallback kullanılır.
const MP_KEY_FALLBACK = "i?LMTAx0Q6,:}50U";
const MP_IV_FALLBACK = "W0;27ToaUpl_P%'c";
const MP_FIX_V = 5; // deploy-doğrulama işareti (stage'de görünür)
let mpKeyCache = null; // { key, iv, at }
// NOT: const-arrow + benzersiz ad (wrangler/esbuild paketinde `async function
// getMegapayKeys` bildirimi düşüyordu — typeof undefined; const-arrow görünür).
const mpFetchKeys = async () => {
  const now = Date.now();
  if (mpKeyCache && now - mpKeyCache.at < 3600_000) return mpKeyCache;
  try {
    const r = await fetchT(`${MEGAPLAY_BASE}/lib/newclient.min.js`, { accept: "text/javascript, */*" }, 10000);
    const js = await r.text();
    // `var P="<key>",w="<iv>"` kalıbı dosyada birden çok geçebilir; doğru
    // olan, devamında `/segment/` geçen ve içinde `/` barındırmayanıdır
    // (şifreli segment URL'leri + düz anahtar metni). Düz string araması —
    // regex kaçış tuzağı yok.
    const rx = /var P="([^"]{8,80})",w="([^"]{8,80})"/g;
    let m = null, best = null, plain = null;
    while ((m = rx.exec(js))) {
      if (m[1].indexOf("/") !== -1 || m[2].indexOf("/") !== -1) continue;
      if (!plain) plain = m;
      if (js.slice(m.index, m.index + 2000).indexOf("/segment/") !== -1) { best = m; break; }
    }
    best = best || plain;
    if (best) {
      mpKeyCache = { key: best[1], iv: best[2], at: now };
      return mpKeyCache;
    }
  } catch (e) { /* fallback'a düş */ }
  mpKeyCache = { key: MP_KEY_FALLBACK, iv: MP_IV_FALLBACK, at: now };
  return mpKeyCache;
}
function mpB64urlToBytes(s) {
  let b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "====".slice(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function decryptMegapayEnc(enc, keyStr, ivStr) {
  const kb = new Uint8Array(32);
  const ke = new TextEncoder().encode(keyStr || "");
  kb.set(ke.subarray(0, Math.min(32, ke.length)));
  const iv = new TextEncoder().encode(ivStr || "");
  const ck = await crypto.subtle.importKey("raw", kb, { name: "AES-CBC" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, mpB64urlToBytes(enc));
  return new TextDecoder().decode(pt);
}
// getSourcesNew yanıtından oynatılabilir m3u8 çıkar: eski `{sources:{file}}`
// ya da yeni `{enc}` (şifreli) formatı. Bulunamazsa/çözülemezse throw
// (çağrıcı stage ile yakalar — uzaktan teşhis için).
async function extractMegapayFile(sourcesJson) {
  if (!sourcesJson) throw new Error("no-json");
  if (sourcesJson.sources && typeof sourcesJson.sources.file === "string") {
    return sourcesJson.sources.file;
  }
  if (typeof sourcesJson.enc === "string" && sourcesJson.enc) {
    const { key, iv } = await mpFetchKeys();
    let plain;
    try {
      plain = await decryptMegapayEnc(sourcesJson.enc, key, iv);
    } catch (e) {
      throw new Error("decrypt-fail:" + ((e && e.message) || "?").slice(0, 40));
    }
    try {
      const obj = JSON.parse(plain);
      if (obj && typeof obj.file === "string") return obj.file;
    } catch (e) { /* düz URL olabilir */ }
    if (/^https?:\/\//i.test(plain.trim())) return plain.trim();
    throw new Error("enc-no-url");
  }
  throw new Error("no-enc-field");
}

// Anikoto arama sayfasındaki ilk bölüm bağlantılarını (title → slug) çıkarır.
// Arama sonuçları `<a class="name d-title" href=".../watch/{slug}/ep-{n}" ...>`.
function parseAnikotoSearchResults(html) {
  const results = [];
  const seen = new Set();
  // data-jp'li ve plain (data-jp'sız) sonuç bağlantılarını iki pass'te çek:
  // her ikisi de `<a href=".../watch/{slug}/ep-{n}">Ad</a>` biçimindedir.
  const rxJp = /<a\b[^>]*\bhref="[^"]*\/watch\/([a-z0-9-]+)\/ep-[0-9]+"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const rxPlain = /<a\b[^>]*\bhref="[^"]*\/watch\/([a-z0-9-]+)\/ep-[0-9]+"[^>]*>([\s\S]*?)<\/a>/gi;
  const clean = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;|<|&gt;|>/g, "").replace(/\s+/g, " ").trim();
  for (const rx of [rxJp, rxPlain]) {
    let m;
    while ((m = rx.exec(html))) {
      const slug = m[1];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const jp = rx === rxJp ? (m[2] || "") : "";
      const name = clean(m[m.length - 1]);
      if (name) results.push({ slug, name, jp });
    }
  }
  return results;
}

async function handleMegapaySource(request, url) {
  const title = url.searchParams.get("title");
  const epRaw = url.searchParams.get("ep") || "1";
  const ep = parseInt(epRaw, 10) || 1;
  if (!title) {
    return new Response(
      JSON.stringify({ status: "error", message: "Missing title parameter" }),
      { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }

  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

  try {
    // 1) title → anikoto iç kimliği. Arama sayfasından slug alınır (title'ın
    //    İngilizce/romaji/eşanlamlısıyla normalleştirilmiş eşleşme tercih edilir).
    const searchRes = await fetchT(`${ANIKOTO_SITE}/search?keyword=${encodeURIComponent(title)}`, {
      referer: ANIKOTO_SITE + "/",
      accept: "text/html, */*",
    }, 10000);
    const searchHtml = await searchRes.text();
    const results = parseAnikotoSearchResults(searchHtml);
    if (results.length === 0) {
      return new Response(
        JSON.stringify({ status: "error", message: "Anime not found on Anikoto", retryable: false }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
    const want = norm(title);
    const chosen =
      results.find((r) => r.name && norm(r.name) === want) ||
      results.find((r) => r.jp && norm(r.jp) === want) ||
      results[0];
    const slug = chosen.slug;

    // 2) slug → anikoto iş içi kimliği (watch sayfasındaki data-anime-id).
    const watchRes = await fetchT(`${ANIKOTO_SITE}/watch/${encodeURIComponent(slug)}/ep-1`, {
      referer: ANIKOTO_SITE + "/",
      accept: "text/html, */*",
    }, 10000);
    const watchHtml = await watchRes.text();
    const idMatch = watchHtml.match(/data-anime-id="?(\d+)"?/i);
    if (!idMatch) {
      return new Response(
        JSON.stringify({ status: "error", message: "Could not resolve Anikoto id", retryable: true }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
    const anikotoId = idMatch[1];

    // 3) iş içi kimlik → bölüm → episode_embed_id (Anikoto API).
    const seriesRes = await fetchT(`${ANIKOTO_API}/series/${anikotoId}`, {
      referer: ANIKOTO_SITE + "/",
      accept: "application/json",
    }, 10000);
    const seriesJson = await seriesRes.json().catch(() => null);
    const episodes = seriesJson && seriesJson.data && Array.isArray(seriesJson.data.episodes)
      ? seriesJson.data.episodes
      : [];
    const epInfo = episodes.find((e) => Number(e.number) === ep) || null;
    const embedId = epInfo && epInfo.episode_embed_id;
    if (!embedId) {
      return new Response(
        JSON.stringify({ status: "error", message: `Episode ${ep} not found on MegaPlay`, retryable: false }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }

    // 4) embed sayfası → data-id (megaplay media kimliği). Bu sayfa Referer
    //    beklemeden hata döner; megavid embed'deki maske gibi doğrudan çekim.
    const embedRes = await fetchT(`${MEGAPLAY_BASE}/stream/s-2/${encodeURIComponent(embedId)}/sub`, {
      referer: MEGAPLAY_BASE + "/",
      accept: "text/html, */*",
    }, 10000);
    const embedHtml = await embedRes.text();
    const mediaMatch = embedHtml.match(/data-id="(\d+)"/) ||
      embedHtml.match(/data-mediaid="(\d+)"/);
    if (!mediaMatch) {
      return new Response(
        JSON.stringify({ status: "error", message: "MegaPlay embed rejected", retryable: true }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
    const mediaId = mediaMatch[1];

    // 5) media id → m3u8 + altyazı track'leri. "AJAX only" koruması X-Requested-With
    //    ile aşılır. getSourcesNew iki format dönebilir: eski `{sources:{file}}`
    //    ya da yeni `{server, enc}` (şifreli — extractMegapayFile çözer).
    //    `s=tcdn` istenir: mikora CDN'e düşer, /proxy + megaplay referer ile
    //    oynar (doğrudan IP-engelli CDN'lere takılmamak için). Olmazsa
    //    parametresiz denenir.
    async function fetchSourcesJson(sParam) {
      const q = `${MEGAPLAY_BASE}/stream/getSourcesNew?id=${encodeURIComponent(mediaId)}` + (sParam ? `&s=${encodeURIComponent(sParam)}` : "");
      const res = await fetchT(q, {
        referer: `${MEGAPLAY_BASE}/stream/s-2/${encodeURIComponent(embedId)}/sub`,
        headers: { "X-Requested-With": "XMLHttpRequest" },
        accept: "application/json, text/plain, */*",
      }, 10000);
      return res.json().catch(() => null);
    }
    let sourcesJson = await fetchSourcesJson("tcdn").catch(() => null);
    let stage = "v" + MP_FIX_V + ":" + (sourcesJson ? "tcdn-json" : "tcdn-fetch-fail");
    let playable = null;
    try {
      playable = await extractMegapayFile(sourcesJson);
      stage += "/extract-ok";
    } catch (e) {
      stage += "/extract:" + ((e && e.message) || "?").slice(0, 50);
    }
    if (!playable) {
      sourcesJson = await fetchSourcesJson(null).catch(() => null);
      stage += sourcesJson ? "+plain-json" : "+plain-fetch-fail";
      try {
        playable = await extractMegapayFile(sourcesJson);
        stage += "/extract-ok";
      } catch (e) {
        stage += "/extract:" + ((e && e.message) || "?").slice(0, 50);
      }
    }
    if (!playable) {
      return new Response(
        JSON.stringify({ status: "error", message: "MegaPlay had no playable stream [" + stage + "]", retryable: true }),
        { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
      );
    }
    // Teşhis stage'i meta'da taşınır (ok yolunda zararsız).
    var mpStage = stage;

    // Bazı MegaPlay CDN'leri (ncdn.imgnex.top gibi) CORS'u *açık* tutar ve
    // tarayıcıdan doğrudan çekilebilir; bazıları (megap.mikora.top vb.) yalnızca
    // megaplay.buzz Referer'ına 200 döner. Tarayıcı o referansı üretemediği için
    // böyle yanıtlarda frontend /proxy üzerinden çeker. Probu burada yaparız.
    // NOT: referer'i KASITLI olarak GÖNDERMİYORUZ — tarayıcı da gönderemeyeceği
    // için "doğrudan oynatılabilir mi" sorusunun doğru cevabı budur. megap.*
    // host'ları megaplay referansıyla 200 döner (ACAO:*) ama tarayıcı o
    // referansı üretemez → bunların direct=false olması gerekir.
    async function megapayDirectProbe(masterUrl) {
      try {
        const res = await fetchT(masterUrl, {}, 8000);
        if (!res.ok) return false;
        const acao = (res.headers.get("Access-Control-Allow-Origin") || "").trim();
        return acao === "*";
      } catch (e) { return false; }
    }
    const direct = await megapayDirectProbe(playable);

    const tracks = (Array.isArray(sourcesJson.tracks) ? sourcesJson.tracks : [])
      .filter((t) => t && typeof t.file === "string" && /\.vtt$/i.test(t.file.split("?")[0]))
      .map((t) => ({ file: t.file, label: t.label || "English", lang: "en" }));

    return new Response(
      JSON.stringify({
        status: "ok",
        source: playable,
        direct,          // true → tarayıcı doğrudan çeker; false → /proxy (worker)
        tracks,
        meta: {
          slug,
          anikotoId,
          embedId,
          mediaId,
          episode: ep,
          sourceName: "MegaPlay",
          stage: (typeof mpStage !== "undefined" ? mpStage : "n/a"),
        },
      }),
      { headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: "error", message: e.message, retryable: true }),
      { status: 502, headers: corsHeaders({ "Content-Type": "application/json" }) },
    );
  }
}

// ---- /admin ---------------------------------------------------------------
// Admin login lives server-side. The key is a Worker secret (ADMIN_KEY), never
// shipped in the client bundle. Login swaps it for an HttpOnly SameSite cookie,
// which the admin UI checks via /admin/check before unlocking the admin page.
//
// Transitional fallback: while deployments haven't set ADMIN_KEY yet we fall
// back to the historical constant — moved here so it stops being public in the
// HTML payload. Once ADMIN_KEY is configured, the fallback is ignored.

const ADMIN_KEY_FALLBACK = "Anv7#kQm2xZ9!wR";
const ADMIN_COOKIE = "anivax_admin=1";

function adminAuthCookie(expires) {
  const parts = [ADMIN_COOKIE, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (expires) parts.push("Max-Age=" + expires);
  return parts.join("; ");
}

async function handleAdminLogin(request, env) {
  let key = null;
  try {
    const body = await request.json();
    key = body && body.key;
  } catch {
    key = null;
  }
  const expected = env && env.ADMIN_KEY ? env.ADMIN_KEY : ADMIN_KEY_FALLBACK;
  const ok = typeof key === "string" && key.length > 0 && key === expected;
  if (!ok) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: corsHeaders({ "Content-Type": "application/json" }) });
  }
  return new Response(
    JSON.stringify({ ok: true }),
    {
      status: 200,
      headers: corsHeaders({
        "Content-Type": "application/json",
        "Set-Cookie": adminAuthCookie(60 * 60 * 24 * 7), // 7 days
      }),
    },
  );
}

function handleAdminLogout() {
  return new Response(
    JSON.stringify({ ok: true }),
    {
      headers: corsHeaders({
        "Content-Type": "application/json",
        "Set-Cookie": ADMIN_COOKIE + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      }),
    },
  );
}

function handleAdminCheck(request) {
  const cookies = request.headers.get("Cookie") || "";
  const authed = cookies.split(";").some((c) => c.trim() === "anivax_admin=1");
  return new Response(
    JSON.stringify({ ok: authed }),
    { status: authed ? 200 : 401, headers: corsHeaders({ "Content-Type": "application/json" }) },
  );
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/source") {
      return await handleSource(request, url);
    }
    if (url.pathname === "/anineko-source") {
      return await handleAninekoSource(request, url);
    }
    if (url.pathname === "/megapay-source") {
      return await handleMegapaySource(request, url);
    }
    if (url.pathname === "/archive-source") {
      return await handleArchiveSource(request, url);
    }
    if (url.pathname === "/proxy") {
      return await handleProxy(request, url);
    }
    if (url.pathname === "/translate") {
      return await handleTranslate(request, url);
    }

    if (url.pathname === "/admin/login") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
      return await handleAdminLogin(request, env);
    }
    if (url.pathname === "/admin/logout") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
      return handleAdminLogout();
    }
    if (url.pathname === "/admin/check") {
      return handleAdminCheck(request);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
