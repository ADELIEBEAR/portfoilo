// Vercel serverless function for AI portfolio diagnosis.
// Keeps GEMINI_API_KEY on the server and never stores uploaded images.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    detected_app: { type: "STRING" },
    confidence: { type: "NUMBER" },
    grade: { type: "STRING" },
    score: { type: "NUMBER" },
    summary: { type: "STRING" },
    holdings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          weight: { type: "NUMBER" },
          return_pct: { type: "NUMBER", nullable: true }
        }
      }
    },
    diagnosis: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          status: { type: "STRING" },
          detail: { type: "STRING" }
        }
      }
    },
    scenarios: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          resilience: { type: "STRING" },
          comment: { type: "STRING" },
          response: { type: "STRING" }
        }
      }
    },
    actions: { type: "ARRAY", items: { type: "STRING" } },
    prescription: {
      type: "OBJECT",
      properties: {
        current_mix: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, pct: { type: "NUMBER" } } } },
        target_mix: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, pct: { type: "NUMBER" } } } },
        target_title: { type: "STRING" },
        rationale: { type: "STRING" },
        steps: { type: "ARRAY", items: { type: "OBJECT", properties: { period: { type: "STRING" }, action: { type: "STRING" } } } }
      }
    },
    error: { type: "STRING", nullable: true }
  }
};

export default async function handler(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "진단 서버 설정이 아직 완료되지 않았어요." });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 사용할 수 있어요." });
  }

  const { images, prompt } = req.body || {};
  if (!Array.isArray(images) || !images.length || !prompt) {
    return res.status(400).json({ error: "잔고 화면 캡처를 올린 뒤 다시 시도해 주세요." });
  }
  if (images.length > 4) {
    return res.status(400).json({ error: "캡처는 최대 4장까지 올릴 수 있어요." });
  }

  const safeImages = images.filter(img => img && /^image\//.test(img.mime || "") && img.data);
  if (!safeImages.length) {
    return res.status(400).json({ error: "이미지 파일만 진단할 수 있어요." });
  }

  const instruction = `${prompt}\n\n판독 정확도 규칙:\n- 이미지에서 실제로 보이는 종목명만 holdings에 넣으세요. 예시 종목을 만들지 마세요.\n- 종목명이나 금액을 충분히 읽을 수 없으면 분석을 꾸미지 말고 error를 반환하세요.\n- confidence는 0~100으로 주세요. 종목명과 금액/비중을 2개 이상 읽으면 70 이상, 일부만 보이면 40~69, 잔고 화면인지 애매하면 40 미만입니다.\n- confidence가 55 미만이면 반드시 error만 반환하세요.\n- 응답은 반드시 유효한 JSON 객체 하나여야 합니다. JSON 외 문장, 마크다운, 마지막 쉼표를 절대 쓰지 마세요.`;

  const parts = [
    { text: instruction },
    ...safeImages.map(img => ({ inline_data: { mime_type: img.mime, data: img.data } }))
  ];

  try {
    const text = await callGemini(parts, {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    });

    let parsed;
    try {
      parsed = parseJson(text);
    } catch (parseError) {
      console.error("[Gemini JSON parse error]", parseError.message, text.slice(0, 800));
      parsed = await repairJson(text);
    }

    return res.status(200).json(normalizeDiagnosis(parsed));
  } catch (e) {
    console.error("[Diagnosis server error]", e);
    return res.status(500).json({ error: "지금은 리포트를 만들지 못했어요. 더 선명한 잔고 화면으로 다시 시도해 주세요." });
  }
}

async function callGemini(parts, generationConfig) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig })
    }
  );

  const data = await r.json();
  if (!r.ok) {
    console.error("[Gemini API error]", r.status, data.error?.message || data);
    throw new Error("Gemini API request failed");
  }

  return (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || "")
    .join("\n")
    .trim();
}

async function repairJson(brokenText) {
  try {
    return parseJson(repairCommonJsonIssues(brokenText));
  } catch (_) {
    const repairPrompt = `아래 텍스트는 깨진 JSON입니다. 내용을 바꾸지 말고 유효한 JSON 객체 하나로만 고쳐서 반환하세요. 설명, 마크다운, 코드블록은 절대 쓰지 마세요.\n\n${String(brokenText || "").slice(0, 12000)}`;
    const fixed = await callGemini([{ text: repairPrompt }], {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json"
    });
    return parseJson(fixed);
  }
}

function parseJson(text) {
  const clean = extractJsonObject(String(text || "").replace(/```json|```/g, "").trim());
  return JSON.parse(repairCommonJsonIssues(clean));
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object in Gemini response");
  }
  return text.slice(start, end + 1);
}

function repairCommonJsonIssues(text) {
  return String(text || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\bNaN\b/g, "null")
    .replace(/\bInfinity\b/g, "null")
    .replace(/\bundefined\b/g, "null");
}

function normalizeDiagnosis(data) {
  if (data?.error) return { error: String(data.error) };

  const holdings = Array.isArray(data?.holdings) ? data.holdings
    .map(h => ({
      name: cleanText(h?.name || "종목", 32),
      weight: clampNumber(h?.weight, 0, 100, 0),
      return_pct: h?.return_pct === null || h?.return_pct === undefined ? null : Number(h.return_pct)
    }))
    .filter(h => h.name && h.name !== "종목") : [];

  const confidence = clampNumber(data?.confidence, 0, 100, holdings.length >= 2 ? 70 : 40);
  const readableHoldings = holdings.filter(h => h.weight > 0 || h.return_pct !== null).length;

  if (confidence < 55 || holdings.length < 1 || readableHoldings < 1) {
    return { error: "종목명과 평가금액이 더 잘 보이는 잔고 화면으로 다시 올려주세요." };
  }

  return {
    detected_app: cleanText(data?.detected_app || "잔고 화면", 24),
    confidence,
    grade: ["A", "B", "C", "D"].includes(data?.grade) ? data.grade : "B",
    score: clampNumber(data?.score, 0, 100, 70),
    summary: cleanText(data?.summary || "업로드한 잔고 화면을 기준으로 계좌 구성을 점검했어요.", 220),
    holdings,
    diagnosis: Array.isArray(data?.diagnosis) ? data.diagnosis.map(item => ({
      title: cleanText(item?.title || "확인할 점", 36),
      status: ["good", "warn", "risk"].includes(item?.status) ? item.status : "warn",
      detail: cleanText(item?.detail || "화면 기준으로 추가 확인이 필요합니다.", 180)
    })) : [],
    scenarios: Array.isArray(data?.scenarios) ? data.scenarios.map(item => ({
      name: cleanText(item?.name || "시장 상황", 28),
      resilience: ["강함", "보통", "취약"].includes(item?.resilience) ? item.resilience : "보통",
      comment: cleanText(item?.comment || "화면 기준으로 판단했습니다.", 140),
      response: cleanText(item?.response || "비중과 현금 여력을 함께 확인해 보세요.", 140)
    })) : [],
    actions: Array.isArray(data?.actions) ? data.actions.map(a => cleanText(a, 140)).slice(0, 5) : [],
    prescription: data?.prescription || null
  };
}

function cleanText(value, max) {
  const text = String(value || "")
    .replace(/([ㄱ-ㅎㅏ-ㅣ가-힣A-Za-z0-9])\1{4,}/g, "$1$1")
    .replace(/[\s\n]+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}