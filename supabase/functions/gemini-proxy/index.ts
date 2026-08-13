// ============================================================================
// Anivax — Gemini proxy (Supabase Edge Function / Deno)
// ----------------------------------------------------------------------------
// 7+ Gemini Flash-Lite key'ini GEMINI_KEYS secret'ında virgülle ayrılmış
// tek listede tutar. Key eklemek = dashboard'da secret'ı güncelle + redeploy.
// Round-robin + per-key hız sınırı + 429/cooldown izolasyonu ile key'ler
// banlanmadan, mümkün olan en hızlı şekilde SSE stream'i passthrough eder.
//
// İstek gövdesi:  { systemPrompt?, userText, thinkingLevel? }
// Yanıt:         Gemini'den gelen SSE stream'i AYNEN geri yazılır.
//                Hata: { status, error:{message} } JSON.
// ============================================================================

const MODEL = 'gemini-3.5-flash-lite';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL;
const STREAM_URL = BASE + ':streamGenerateContent?alt=sse&key=';
const GEN_URL = BASE + ':generateContent?key=';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// --- Hız/cooldown ayarları (free tier güvenliği, Flash-Lite ~15 RPM/key) ---
// Key başına istekler arası minimum süre. 4s → key başına ~14 RPM.
const MIN_GAP_MS = 4000;
// 429 (rate limited) sonrası o key için bekleme. Retry-After varsa o kullanılır.
const COOLDOWN_429_MS = 60_000;
// 429 + "quota"/"daily" (günlük limit) → 24s. ban riski.
const COOLDOWN_DAILY_MS = 24 * 60 * 60 * 1000;
// Art arda hata katlanması üst sınırı.
const MAX_ESCALATION = 7;

// Deno isolate yaşadığı sürece yaşayan in-memory durum.
// DİKKAT: Supabase edge function'ları istek başına TAZE isolate kurabilir —
// in-memory sayaç/cooldown yalnızca "ek" koruma, asıl dağıtım aşağıdaki
// zaman tabanlı slot'tur (tüm isolate'lar için deterministik).
const S = (globalThis as any).__geminiProxyState as any || {
  lastUsed: [] as number[],      // per-key son kullanım ms (warm isolate)
  cooldownUntil: [] as number[], // per-key cooldown bitiş ms (warm isolate)
  strike: [] as number[],        // per-key art arda hata sayısı (warm isolate)
};
(globalThis as any).__geminiProxyState = S;

function keys(): string[] {
  return (Deno.env.get('GEMINI_KEYS') || '').split(',')
    .map(k => k.trim())
    .filter(Boolean);
}

function json(data: any, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...headers },
  });
}

// Zaman tabanlı slot: her MIN_GAP_MS penceresinde farklı key seçilir. Bu,
// isolate yaşam döngüsünden BAĞIMSIZ çalışır — 7 key ve 4s pencere ile key
// başına ~1 istek/4s (~15 RPM sınırının güvenli altında) garantilenir.
// Örnek: now=0s→key0, 4s→key1, 8s→key2, ... 28s→key0.
function slotKey(count: number): number {
  return Math.floor(Date.now() / MIN_GAP_MS) % count;
}

// Warm isolate'da ek doğrulama: seçilen key hâlâ cooldown'daysa bir sonraki
// müsait key'e atla (soğuk başlangıçta her şey müsait → slot korunur).
function pickKey(count: number, preferred: number): { idx: number; waitMs: number } {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const idx = (preferred + i) % count;
    const readyAt = Math.max(S.lastUsed[idx] || 0, S.cooldownUntil[idx] || 0);
    if (readyAt <= now) return { idx, waitMs: 0 };
  }
  // Hepsi meşgul → en erken boşalacak olanı seç.
  let best = 0;
  let bestAt = Infinity;
  for (let i = 0; i < count; i++) {
    const readyAt = Math.max(S.lastUsed[i] || 0, S.cooldownUntil[i] || 0);
    if (readyAt < bestAt) { bestAt = readyAt; best = i; }
  }
  return { idx: best, waitMs: Math.max(0, bestAt - now) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ status: 405, error: { message: 'method not allowed' } }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* fallthrough */ }

  const userText = typeof body.userText === 'string' && body.userText.trim() ? body.userText.trim() : '';
  if (!userText) {
    return json({ status: 400, error: { message: 'userText is required' } }, 400);
  }
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
  // Paylaşımlı havuzdaki tüm key'ler HIGH variant ile çalışır (kullanıcı kararı).
  const thinkingLevel = 'HIGH';
  const isRepair = body.repair === true; // non-streaming onarım isteği

  const k = keys();
  if (!k.length) {
    return json({ status: 503, error: { message: 'no Gemini keys configured' } }, 503);
  }

  const geminiBody: any = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel },
    },
  };
  if (isRepair) {
    geminiBody.generationConfig.responseMimeType = 'application/json';
    geminiBody.generationConfig.responseSchema = { type: 'ARRAY', items: { type: 'STRING' } };
  }
  if (systemPrompt) geminiBody.systemInstruction = { parts: [{ text: systemPrompt }] };

  // Key başına en fazla bir deneme; hangi key kullanıldıysa header ile raporla.
  const attempts = Math.min(k.length, 4);
  let lastErr = 'unknown error';

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { idx, waitMs } = pickKey(k.length, slotKey(k.length));

    // Tüm key'ler cooldown'da → istemciye retry bildir. Ban riski sıfır.
    if (waitMs > 5000) {
      const retry = Math.ceil(waitMs / 1000);
      return json(
        { status: 429, error: { message: 'all Gemini keys cooling down — retry in ' + retry + 's' } },
        429,
        { 'Retry-After': String(retry) }
      );
    }
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

    S.lastUsed[idx] = Date.now();
    const apiKey = k[idx];

    let resp: Response;
    try {
      const url = isRepair ? GEN_URL : STREAM_URL;
      resp = await fetch(url + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
    } catch (e) {
      lastErr = 'upstream fetch failed: ' + (e && (e as any).message ? (e as any).message : String(e));
      S.strike[idx] = (S.strike[idx] || 0) + 1;
      escalate(idx);
      continue; // bir sonraki key ile dene
    }

    // Başarılı → repair ise JSON metni, değilse Gemini'nin SSE body'sini aynen akıt.
    if (resp.ok) {
      S.strike[idx] = 0;
      if (isRepair) {
        const text = await resp.text();
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Gemini-Key': String(idx + 1), ...CORS },
        });
      }
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Gemini-Key': String(idx + 1),
          ...CORS,
        },
      });
    }

    // Hata: body'yi oku, 429/5xx sınıflandır.
    let errText = '';
    try { errText = (await resp.text()) || ''; } catch { /* ignore */ }
    const status = resp.status;
    lastErr = errText.slice(0, 400) || 'Gemini HTTP ' + status;

    if (status === 429) {
      S.strike[idx] = (S.strike[idx] || 0) + 1;
      // Günlük kota mesajları → 24s, diğer → kısa cooldown (Retry-After öncelikli).
      const isDaily = /quota|daily|RESOURCE_EXHAUSTED|per day/i.test(errText);
      let cd = isDaily ? COOLDOWN_DAILY_MS : COOLDOWN_429_MS;
      const retryAfter = resp.headers.get('Retry-After');
      if (retryAfter && /^\d+$/.test(retryAfter)) cd = Number(retryAfter) * 1000;
      S.cooldownUntil[idx] = Date.now() + cd;
      continue; // başka key ile dene
    }
    if (status >= 500) {
      S.strike[idx] = (S.strike[idx] || 0) + 1;
      escalate(idx);
      continue;
    }
    // 4xx (schema/prompt hataları) → başka key'de de aynı olur, geri dön.
    return json({ status: 502, error: { message: lastErr } }, 502, { 'X-Gemini-Key': String(idx + 1) });
  }

  return json({ status: 503, error: { message: 'all keys failed: ' + lastErr.slice(0, 200) } }, 503);
});

function escalate(idx: number) {
  const n = S.strike[idx] || 0;
  // Katlanmalı cooldown: 30s, 2m, 5m, ... üst sınırla.
  const mult = Math.min(n, MAX_ESCALATION);
  const cd = 30_000 * Math.pow(2, mult);
  S.cooldownUntil[idx] = Date.now() + cd;
}
