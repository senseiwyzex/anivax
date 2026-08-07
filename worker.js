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
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Keep these safe/fixed — they identify an ordinary browser embed, not a bot.
function edgeFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Referer: opts.referer || MEGAVID_BASE + "/",
      Origin: opts.origin || MEGAVID_BASE,
      Accept: opts.accept || "*/*",
      ...(opts.headers || {}),
    },
  });
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
      const res = await edgeFetch(MEGAVID_BASE + path, {
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
    const res = await edgeFetch(targetUrl.href, {
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
  const embedRes = await edgeFetch(embedUrl, { referer: pageUrl });
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
    const res = await edgeFetch(clean, { referer: pageUrl });
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
      const searchRes = await edgeFetch(
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
    const pageRes = await edgeFetch(pageUrl, { referer: ANINEKO_BASE + "/" });
    const pageHtml = await pageRes.text();
    const dataVideos = [...pageHtml.matchAll(/data-video="([^"]+)"/g)].map((m) => m[1]);

    const pick = (hostPattern, hint) => {
      const family = dataVideos.filter((u) => hostPattern.test(u));
      if (family.length === 0) return null;
      const withHint = family.find((u) => hint && u.includes(hint));
      // Prefer the softsub variant (caption/sub params); else take the first.
      return withHint || family.find((u) => /\?(sub|caption_|sub_|c[0-9]_)/.test(u)) || family[0];
    };

    const bibiembUrl = pick(/^https:\/\/vivibebe\.site\//i, "sub=");
    const otakuhgUrl = pick(/^https:\/\/otakuhg\.site\/e\//i, null);
    const otakuvidUrl = pick(/^https:\/\/otakuvid\.online\/embed\//i, "caption_");

    // 2) Resolve every family in parallel. bibiemb's data-video URL is the
    //    master playlist itself; otakuhg/otakuvid are packed embeds resolved by
    //    the shared extractor. All run concurrently, so this still costs ONE
    //    frontend request per episode.
    const [bibiemb, otakuhg, otakuvid] = await Promise.all([
      resolveBibiemb(bibiembUrl, pageUrl),
      resolvePackedEmbed(otakuhgUrl, pageUrl),
      resolvePackedEmbed(otakuvidUrl, pageUrl),
    ]);

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

    // Sıralama önemli: Otakuhg en hızlı/güvenilir aile → Sunucu 1. Bibiemb
    // (vivibebe) ortada, Otakuvid son sırada (Sunucu 3). Kullanıcı bu sırayı
    // istedi: en hızlı kaynak birinci, otakuvid üçüncü.
    const sources = [
      { key: "otakuhg", name: "Otakuhg", source: otakuhg },
      { key: "bibiemb", name: "Bibiemb", source: bibiemb },
      { key: "otakuvid", name: "Otakuvid", source: otakuvid },
    ].filter((s) => s.source);

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

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
