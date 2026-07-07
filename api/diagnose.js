// Vercel serverless function for AI portfolio diagnosis.
// Keeps GEMINI_API_KEY on the server and never stores uploaded images.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    detected_app: { type: "STRING" },
    grade: { type: "STRING", enum: ["A", "B", "C", "D"] },
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
        },
        required: ["name", "weight", "return_pct"]
      }
    },
    diagnosis: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          status: { type: "STRING", enum: ["good", "warn", "risk"] },
          detail: { type: "STRING" }
        },
        required: ["title", "status", "detail"]
      }
    },
    scenarios: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          resilience: { type: "STRING", enum: ["강함", "보통", "취약"] },
          comment: { type: "STRING" },
          response: { type: "STRING" }
        },
        required: ["name", "resilience", "comment", "response"]
      }
    },
    actions: { type: "ARRAY", items: { type: "STRING" } },
    prescription: {
      type: "OBJECT",
      properties: {
        current_mix: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { label: { type: "STRING" }, pct: { type: "NUMBER" } },
            required: ["label", "pct"]
          }
        },
        target_mix: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { label: { type: "STRING" }, pct: { type: "NUMBER" } },
            required: ["label", "pct"]
          }
        },
        target_title: { type: "STRING" },
        rationale: { type: "STRING" },
        steps: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { period: { type: "STRING" }, action: { type: "STRING" } },
            required: ["period", "action"]
          }
        }
      },
      required: ["current_mix", "target_mix", "target_title", "rationale", "steps"]
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

  const parts = [
    ...safeImages.map(img => ({ inline_data: { mime_type: img.mime, data: img.data } })),
    { text: `${prompt}\n\n중요: 응답은 반드시 유효한 JSON 객체 하나여야 합니다. 마지막 항목 뒤에 쉼표를 넣지 마세요. JSON 외 문장은 절대 쓰지 마세요.` }
  ];

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA
          }
        })
      }
    );

    const data = await r.json();
    if (!r.ok) {
      console.error("[Gemini API error]", r.status, data.error?.message || data);
      return res.status(502).json({ error: "진단 서버에 일시적인 문제가 발생했어요. 잠시 후 다시 시도해 주세요." });
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "")
      .join("\n")
      .trim();

    const parsed = parseJson(text);
    return res.status(200).json(parsed);
  } catch (e) {
    console.error("[Diagnosis parse/server error]", e);
    return res.status(500).json({ error: "AI 응답을 리포트로 정리하지 못했어요. 같은 캡처로 한 번만 다시 시도해 주세요." });
  }
}

function parseJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object in Gemini response");
  }
  return JSON.parse(clean.slice(start, end + 1));
}
