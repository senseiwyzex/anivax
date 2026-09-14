// ============================================================================
// Anivax — admin-config (Supabase Edge Function / Deno)
// ----------------------------------------------------------------------------
// site_config (sub_prompt + ai_model) yazma işlemi buradan yapılır. Sebep:
// site_config INSERT/UPDATE RLS politikaları `auth.uid() is not null` ister,
// ama site admin girişi worker-cookie ile olur — Supabase Auth oturumu YOK.
// Anon istemciden upsert 403 yer, hata yutulur, refresh'te ayarlar "başa döner".
//
// Bu fonksiyon ADMIN_KEY secret'ını doğrular, yazmayı service_role ile yapar.
// ADMIN_KEY secret'ı dashboard/Management API ile kurulur (değeri repoda YOK).
//
// İstek gövdesi: { key, prompt?, model?, thinking?, proofThinking? } (eksik alanlar korunur)
// Yanıt: { ok:true, saved:{prompt,model,thinking} } ya da { status, error }.
// ============================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(data: any, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ status: 405, error: { message: 'method not allowed' } }, 405);

  const adminKey = (Deno.env.get('ADMIN_KEY') || '').trim();
  if (!adminKey) {
    return json({ status: 503, error: { message: 'admin key not configured' } }, 503);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* fallthrough */ }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key || key !== adminKey) {
    return json({ status: 401, error: { message: 'unauthorized' } }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL') || '';
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !svc) {
    return json({ status: 503, error: { message: 'supabase env missing' } }, 503);
  }

  // Mevcut değerleri oku (eksik alanlar korunur — ör. yalnız prompt değiştiyse
  // model/thinking ezilmez).
  async function readCfg(cfgKey: string): Promise<any> {
    try {
      const r = await fetch(url + '/rest/v1/site_config?key=eq.' + encodeURIComponent(cfgKey) + '&select=data', {
        headers: { 'apikey': svc, 'Authorization': 'Bearer ' + svc },
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return (Array.isArray(j) && j[0] && j[0].data) ? j[0].data : null;
    } catch { return null; }
  }

  async function writeCfg(cfgKey: string, data: any): Promise<boolean> {
    try {
      const r = await fetch(url + '/rest/v1/site_config', {
        method: 'POST',
        headers: {
          'apikey': svc,
          'Authorization': 'Bearer ' + svc,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ key: cfgKey, data, updated_at: new Date().toISOString() }),
      });
      return r.ok;
    } catch { return false; }
  }

  const saved: any = {};
  let okAll = true;

  if (typeof body.prompt === 'string') {
    const ok = await writeCfg('sub_prompt', { prompt: body.prompt });
    okAll = okAll && ok;
    saved.prompt = ok;
  }
  if (typeof body.model === 'string' || typeof body.thinking === 'string' || typeof body.proofThinking === 'string') {
    const cur = (await readCfg('ai_model')) || {};
    const data: any = { ...cur };
    if (typeof body.model === 'string') data.model = body.model;
    if (typeof body.thinking === 'string') data.thinking = body.thinking;
    // Redaktör thinking'i (site_config ai_model.proofThinking) — aynı merge,
    // verilmeyen alan korunur. Geçersiz değer yazılmaz.
    if (typeof body.proofThinking === 'string' && ['minimal','low','medium','high'].includes(body.proofThinking.trim().toLowerCase())) {
      data.proofThinking = body.proofThinking.trim().toLowerCase();
    }
    const ok = await writeCfg('ai_model', data);
    okAll = okAll && ok;
    saved.model = ok;
  }

  // Kaynak anahtarları (sources: otakuhg/bibiemb/otakuvid/megavid/megapay/
  // directOtaku) — aynı RLS duvarı burada da vardı: anon toggle sahte
  // görünür, refresh geri alırdı. Merge yazılır (verilmeyen anahtar korunur).
  if (body.sources && typeof body.sources === 'object' && !Array.isArray(body.sources)) {
    const cur = (await readCfg('sources')) || {};
    const data: any = { ...cur, ...body.sources };
    const ok = await writeCfg('sources', data);
    okAll = okAll && ok;
    saved.sources = ok;
  }

  if (!okAll) {
    return json({ status: 502, error: { message: 'config write failed', saved } }, 502);
  }
  return json({ ok: true, saved }, 200);
});
