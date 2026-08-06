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
  // Only ever fetch from the Megavid ecosystem to avoid becoming an open proxy.
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("Invalid url parameter", { status: 400, headers: corsHeaders() });
  }
  if (!targetUrl.hostname.endsWith("megavid.buzz") && targetUrl.hostname !== "megavid.buzz") {
    return new Response("Host not allowed", { status: 403, headers: corsHeaders() });
  }

  const isPlaylist = targetUrl.pathname.endsWith(".m3u8");
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
    const res = await edgeFetch(targetUrl.href, {
      referer: referer,
      origin: MEGAVID_BASE,
      accept: isPlaylist
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

    if (isPlaylist) {
      // Rewrite playlist lines: absolute/relative segment + key URIs become
      // /proxy?url=<encoded>&referer=<encoded>.
      const text = await res.text();
      const rewritten = text
        .split("\n")
        .map((line) => {
          const l = line.trim();
          if (!l || l.startsWith("#")) return line;
          let abs;
          try {
            abs = new URL(l, targetUrl.href);
          } catch {
            return line;
          }
          const proxied =
            base.origin +
            "/proxy?url=" +
            encodeURIComponent(abs.href) +
            "&referer=" +
            encodeURIComponent(referer);
          return line.replace(l, proxied);
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
    const buffer = await res.arrayBuffer();
    const payload = stripPngMask(new Uint8Array(buffer));
    const oneDay = 86400;
    const cacheSecs = isSub ? oneDay : 7 * oneDay;
    return new Response(payload, {
      headers: corsHeaders({
        "Content-Type": isSub ? "text/vtt; charset=utf-8" : contentType,
        "Cache-Control": `public, max-age=${cacheSecs}, immutable`,
      }),
    });
  } catch (e) {
    return new Response("Proxy error: " + e.message, {
      status: 502,
      headers: corsHeaders(),
    });
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
    if (url.pathname === "/proxy") {
      return await handleProxy(request, url);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
