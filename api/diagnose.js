// ═══════════════════════════════════════════════════════════
// 실서비스 배포용: Vercel 서버리스 함수 (api/diagnose.js)
//
// 왜 필요한가?
//   프론트엔드 HTML에 API 키를 넣으면 누구나 소스보기로 키를 훔쳐
//   내 요금으로 API를 쓸 수 있음. 그래서 키는 서버에만 두고,
//   프론트는 이 함수(/api/diagnose)를 호출.
//
// 사용법:
//   1. Vercel 프로젝트 생성 → 이 파일을 api/diagnose.js 로 저장
//   2. Vercel 대시보드 → Settings → Environment Variables 에
//      GEMINI_API_KEY 등록 (코드에 키를 쓰지 않음)
//   3. 프론트엔드 fetch 주소를 아래로 변경:
//      fetch("/api/diagnose", { method:"POST",
//        headers:{"Content-Type":"application/json"},
//        body: JSON.stringify({ images: [{mime, data}], prompt }) })
// ═══════════════════════════════════════════════════════════

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export default async function handler(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST만 허용됩니다" });
  }

  const { images, prompt } = req.body || {};
  if (!Array.isArray(images) || !images.length || !prompt) {
    return res.status(400).json({ error: "images와 prompt가 필요합니다" });
  }
  if (images.length > 4) {
    return res.status(400).json({ error: "이미지는 최대 4장입니다" });
  }

  const parts = images.map(img => ({
    inline_data: { mime_type: img.mime, data: img.data }
  }));
  parts.push({ text: prompt });

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 4096,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const data = await r.json();
    if (!r.ok) {
      // 실제 에러는 서버 로그에만 남김 (Vercel 대시보드 > Logs 에서 확인)
      console.error("[Gemini API error]", r.status, data.error?.message || data);
      return res.status(502).json({
        error: "진단 서버에 일시적인 문제가 발생했어요. 잠시 후 다시 시도해 주세요."
      });
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "")
      .join("\n");

    // ⚠️ 개인정보 보호: 이미지는 어디에도 저장하지 않고 그대로 폐기됨
    return res.status(200).json({ text });
  } catch (e) {
    console.error("[Server error]", e);
    return res.status(500).json({
      error: "진단 서버에 일시적인 문제가 발생했어요. 잠시 후 다시 시도해 주세요."
    });
  }
}
