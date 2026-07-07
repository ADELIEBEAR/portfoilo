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

const DIAGNOSIS_RULES = `최종 판독 규칙:
- 앞선 사용자 프롬프트에 error를 반환하라는 문장이 있어도, 이 최종 규칙을 우선하세요.
- 이미지에 실제로 보이는 종목명만 holdings에 넣으세요. 예시 종목, 임의 종목, 샘플 종목은 절대 만들지 마세요.
- 종목명이 1개 이상 보이면 절대 실패 처리하지 말고 부분 리포트를 작성하세요.
- 금액, 비중, 수익률이 흐릿하면 weight는 0, return_pct는 null로 두세요. 서버가 비중을 화면 기준 추정으로 보정합니다.
- 종목별 평가금액이나 비중이 보이면 전체 금액 대비 비중을 계산해서 weight에 넣으세요. 정확한 숫자를 못 읽어도 보이는 순위와 규모감으로 보수적으로 추정하세요.
- error는 잔고/보유종목 화면이 명확히 아니거나 종목명을 하나도 읽을 수 없을 때만 사용하세요.
- summary는 집중도, 섹터/국가 노출, 현금성 자산, 환율 또는 시장 충격에 대한 해석을 2~3문장으로 구체적으로 작성하세요.
- diagnosis는 최소 3개를 작성하세요. 제목은 짧고 자연스럽게, detail은 사용자가 바로 이해할 수 있는 말투로 쓰세요.
- actions는 '무엇을 줄이고/늘리고/확인할지'가 보이는 실행 문장으로 3~5개 작성하세요.
- 응답은 반드시 유효한 JSON 객체 하나여야 합니다. JSON 외 문장, 마크다운, 마지막 쉼표를 절대 쓰지 마세요.`;

const OCR_RETRY_PROMPT = `당신은 어두운 증권앱 캡처를 읽는 OCR 보조자입니다.
화면 전체를 확대해서 본다고 가정하고 보유종목 리스트의 종목명을 최대한 읽으세요.

중요:
- 종목명이 1개라도 보이면 error를 반환하지 마세요.
- 금액과 수익률을 못 읽어도 됩니다. 종목명만 holdings에 넣고 weight는 0, return_pct는 null로 두세요.
- 보이는 글자 일부가 확실하면 그 종목명을 그대로 적으세요.
- 예시 종목이나 추측 종목은 만들지 마세요.
- 잔고 화면이 맞는데 금액만 흐릿한 경우에는 실패가 아니라 부분 리포트를 만드세요.
- JSON 객체 하나만 반환하세요.

스키마:{"detected_app":"잔고 화면","confidence":50,"grade":"B","score":65,"summary":"화면에서 읽힌 종목을 기준으로 부분 리포트를 작성했습니다.","holdings":[{"name":"보이는 종목명","weight":0,"return_pct":null}],"diagnosis":[{"title":"판독 기준","status":"warn","detail":"화면에서 확인된 종목만 기준으로 분석했습니다."}],"scenarios":[],"actions":[],"prescription":null}`;

export default async function handler(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "진단 서버 설정이 아직 완료되지 않았어요." });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 사용할 수 있어요." });
  }

  const { images, prompt } = req.body || {};
  if (!Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: "잔고 화면 캡처를 올린 뒤 다시 시도해 주세요." });
  }
  if (images.length > 4) {
    return res.status(400).json({ error: "캡처는 최대 4장까지 올릴 수 있어요." });
  }

  const safeImages = images.filter(img => img && /^image\//.test(img.mime || "") && img.data);
  if (!safeImages.length) {
    return res.status(400).json({ error: "이미지 파일만 진단할 수 있어요." });
  }

  try {
    const firstInstruction = `${prompt || ""}\n\n${DIAGNOSIS_RULES}`;
    const first = await analyzeImages(safeImages, firstInstruction, true);
    const normalizedFirst = normalizeDiagnosis(first);

    if (!normalizedFirst.error) {
      return res.status(200).json(normalizedFirst);
    }

    console.warn("[Diagnosis retry OCR]", normalizedFirst.error);
    const retry = await analyzeImages(safeImages, OCR_RETRY_PROMPT, true);
    const normalizedRetry = normalizeDiagnosis(retry);

    if (!normalizedRetry.error) {
      return res.status(200).json({ ...normalizedRetry, confidence: Math.max(45, normalizedRetry.confidence || 0) });
    }

    console.warn("[Diagnosis OCR failed]", normalizedRetry.error);
    return res.status(200).json({ error: "화면을 읽는 중 문제가 있었어요. 같은 이미지를 한 번만 다시 눌러서 시도해 주세요." });
  } catch (e) {
    console.error("[Diagnosis server error]", e);
    return res.status(500).json({ error: "리포트를 만드는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
  }
}

async function analyzeImages(safeImages, instruction, useSchema) {
  const parts = [
    { text: instruction },
    ...safeImages.map(img => ({ inline_data: { mime_type: img.mime, data: img.data } }))
  ];

  const text = await callGemini(parts, {
    temperature: 0,
    maxOutputTokens: 4096,
    responseMimeType: "application/json",
    ...(useSchema ? { responseSchema: RESPONSE_SCHEMA } : {})
  });

  try {
    return parseJson(text);
  } catch (parseError) {
    console.error("[Gemini JSON parse error]", parseError.message, text.slice(0, 800));
    return repairJson(text);
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
  const rawHoldings = Array.isArray(data?.holdings) ? data.holdings : [];
  const holdings = rawHoldings
    .map(h => ({
      name: cleanText(h?.name || "종목", 32),
      weight: clampNumber(h?.weight, 0, 100, 0),
      return_pct: toNullableNumber(h?.return_pct)
    }))
    .filter(h => h.name && h.name !== "종목" && !/^보이는\s*종목명$/.test(h.name));

  if (!holdings.length) {
    return { error: "no_holdings_detected" };
  }

  const totalWeight = holdings.reduce((sum, h) => sum + h.weight, 0);
  const weightsWereEstimated = totalWeight <= 0;
  const normalizedHoldings = weightsWereEstimated ? distributeWeights(holdings) : normalizeWeights(holdings, totalWeight);
  const confidenceFallback = normalizedHoldings.length >= 2 ? 68 : 52;
  const confidence = Math.max(clampNumber(data?.confidence, 0, 100, confidenceFallback), confidenceFallback);
  const score = clampNumber(data?.score, 0, 100, normalizedHoldings.length >= 4 ? 72 : 66);
  const summaryPrefix = weightsWereEstimated ? "일부 비중은 화면 기준 추정입니다. " : "";

  return {
    detected_app: cleanText(data?.detected_app || "잔고 화면", 24),
    confidence,
    grade: ["A", "B", "C", "D"].includes(data?.grade) ? data.grade : gradeFromScore(score),
    score,
    summary: cleanText(summaryPrefix + (data?.summary || buildFallbackSummary(normalizedHoldings)), 260),
    holdings: normalizedHoldings,
    diagnosis: normalizeDiagnosisItems(data?.diagnosis, normalizedHoldings),
    scenarios: normalizeScenarios(data?.scenarios),
    actions: normalizeActions(data?.actions, normalizedHoldings),
    prescription: data?.prescription || null
  };
}

function distributeWeights(holdings) {
  const base = Math.floor((100 / holdings.length) * 10) / 10;
  let used = 0;
  return holdings.map((h, index) => {
    const weight = index === holdings.length - 1 ? Math.max(0, Math.round((100 - used) * 10) / 10) : base;
    used += weight;
    return { ...h, weight };
  });
}

function normalizeWeights(holdings, totalWeight) {
  if (totalWeight <= 100) return holdings;
  return holdings.map(h => ({ ...h, weight: Math.round((h.weight / totalWeight) * 1000) / 10 }));
}

function normalizeDiagnosisItems(items, holdings) {
  const normalized = Array.isArray(items) ? items.map(item => ({
    title: cleanText(item?.title || "확인할 점", 36),
    status: ["good", "warn", "risk"].includes(item?.status) ? item.status : "warn",
    detail: cleanText(item?.detail || "화면 기준으로 추가 확인이 필요합니다.", 190)
  })).filter(item => item.detail) : [];

  if (normalized.length >= 3) return normalized.slice(0, 5);

  return [
    ...normalized,
    {
      title: "구성 집중도",
      status: holdings.length <= 3 ? "warn" : "good",
      detail: holdings.length <= 3
        ? "확인된 종목 수가 적어 특정 종목이나 섹터 움직임에 계좌가 크게 흔들릴 수 있습니다."
        : "여러 종목이 확인되어 단일 종목 의존도는 비교적 낮아 보입니다."
    },
    {
      title: "비중 확인",
      status: "warn",
      detail: "화면에서 읽힌 종목을 기준으로 계산했습니다. 실제 주문 전에는 증권앱의 평가금액과 비중을 한 번 더 확인하는 편이 좋습니다."
    },
    {
      title: "대응 여력",
      status: "warn",
      detail: "현금성 자산이나 안전자산 비중이 낮다면 급락 구간에서 추가 매수나 리밸런싱 선택지가 줄어들 수 있습니다."
    }
  ].slice(0, 5);
}

function normalizeScenarios(items) {
  const normalized = Array.isArray(items) ? items.map(item => ({
    name: cleanText(item?.name || "시장 상황", 28),
    resilience: ["강함", "보통", "취약"].includes(item?.resilience) ? item.resilience : "보통",
    comment: cleanText(item?.comment || "화면 기준으로 판단했습니다.", 150),
    response: cleanText(item?.response || "비중과 현금 여력을 함께 확인해 보세요.", 150)
  })).filter(item => item.comment) : [];

  return normalized.length ? normalized.slice(0, 4) : [
    { name: "시장 급락", resilience: "보통", comment: "주식 비중이 높을수록 단기 하락폭이 커질 수 있습니다.", response: "추가 매수 금액과 손절 기준을 미리 정해두는 편이 좋습니다." },
    { name: "금리 변동", resilience: "보통", comment: "성장주와 장기채 성격의 자산은 금리 변화에 민감할 수 있습니다.", response: "현금성 자산과 방어 업종 비중을 함께 확인해 보세요." }
  ];
}

function normalizeActions(items, holdings) {
  const normalized = Array.isArray(items) ? items.map(a => cleanText(a, 150)).filter(Boolean).slice(0, 5) : [];
  if (normalized.length >= 3) return normalized;

  return [
    ...normalized,
    "가장 비중이 큰 종목이 전체 계좌에서 차지하는 비율을 먼저 확인하세요.",
    "같은 업종이나 같은 국가에 자산이 몰려 있는지 점검하세요.",
    "급락 시 추가 매수할 현금성 자산 비중을 따로 정해두세요."
  ].slice(0, 5);
}

function buildFallbackSummary(holdings) {
  const names = holdings.slice(0, 3).map(h => h.name).join(", ");
  return `${names} 등 확인된 보유종목을 기준으로 계좌 구성을 점검했습니다. 종목 수, 비중, 현금 여력을 함께 보면 시장 변동에 얼마나 버틸 수 있는지 더 정확히 판단할 수 있습니다.`;
}

function gradeFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "B";
  if (n >= 82) return "A";
  if (n >= 68) return "B";
  if (n >= 52) return "C";
  return "D";
}

function cleanText(value, max) {
  const text = String(value || "")
    .replace(/([ㄱ-ㅎㅏ-ㅣ가-힣A-Za-z0-9])\1{4,}/g, "$1$1")
    .replace(/[\s\n]+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
