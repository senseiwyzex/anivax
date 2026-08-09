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
  const hostAllowed =
    ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h)) ||
    isOtakuvidStream;
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
    if (isOtakuvidStream) {
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
