// Stores expert consultation requests in Supabase.
// Required Vercel env vars:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// CONSULTATION_ADMIN_TOKEN

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "상담 신청 저장소 설정이 아직 완료되지 않았어요." });
  }

  if (req.method === "POST") return createRequest(req, res);
  if (req.method === "GET") return listRequests(req, res);

  return res.status(405).json({ error: "지원하지 않는 요청입니다." });
}

async function createRequest(req, res) {
  const { phone, consent, diagnosis } = req.body || {};
  const normalizedPhone = String(phone || "").replace(/[^0-9]/g, "");

  if (!consent) {
    return res.status(400).json({ error: "개인정보 수집 동의가 필요해요." });
  }
  if (normalizedPhone.length < 10 || normalizedPhone.length > 11) {
    return res.status(400).json({ error: "전화번호를 정확히 입력해 주세요." });
  }

  const payload = {
    phone: normalizedPhone,
    source: "portfolio_diagnosis",
    grade: diagnosis?.grade || null,
    score: Number.isFinite(Number(diagnosis?.score)) ? Number(diagnosis.score) : null,
    detected_app: diagnosis?.detected_app || null,
    summary: diagnosis?.summary || null,
    holdings_count: Array.isArray(diagnosis?.holdings) ? diagnosis.holdings.length : 0,
    consent: true,
    created_at: new Date().toISOString()
  };

  const response = await supabaseFetch("/rest/v1/consultation_requests", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("[Supabase insert error]", response.status, detail);
    return res.status(502).json({ error: "신청 저장에 실패했어요. 잠시 후 다시 시도해 주세요." });
  }

  return res.status(200).json({ ok: true });
}

async function listRequests(req, res) {
  const token = String(req.query?.token || "");
  if (!process.env.CONSULTATION_ADMIN_TOKEN || token !== process.env.CONSULTATION_ADMIN_TOKEN) {
    return res.status(401).json({ error: "관리자 토큰이 필요해요." });
  }

  const response = await supabaseFetch("/rest/v1/consultation_requests?select=*&order=created_at.desc&limit=200", {
    method: "GET"
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("[Supabase list error]", response.status, detail);
    return res.status(502).json({ error: "요청 목록을 불러오지 못했어요." });
  }

  const rows = await response.json();
  return res.status(200).json({ rows });
}

function supabaseFetch(path, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}
