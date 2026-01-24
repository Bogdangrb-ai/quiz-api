require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");

const app = express();

// ------------------- CONFIG -------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function needEnv(name) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
}

function normalizeLanguage(lang) {
  if (!lang || typeof lang !== "string") return "en";
  const v = lang.trim();
  return v ? v : "en";
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function chunkText(text, chunkSize = 6000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  return chunks;
}

// ------------------- OPENAI (Responses API) -------------------
function extractAnyTextFromResponsesApi(data) {
  if (!data) return "";

  // Most convenient, sometimes present
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // Scan output items for content text
  const out = Array.isArray(data.output) ? data.output : [];
  const texts = [];

  for (const item of out) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.trim()) texts.push(c.text.trim());
      if (typeof c?.output_text === "string" && c.output_text.trim()) texts.push(c.output_text.trim());
    }
  }

  return texts.join("\n").trim();
}

async function openaiCall({ input, schema }) {
  needEnv("OPENAI_API_KEY");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_output_tokens: 2500,
      input,
      text: {
        format: {
          type: "json_schema",
          name: "quiz",
          strict: true,
          schema,
        },
      },
    }),
  });

  const rawBody = await resp.text();

  if (!resp.ok) {
    throw new Error(`OpenAI error ${resp.status}: ${rawBody.slice(0, 1200)}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`OpenAI returned non-JSON body: ${rawBody.slice(0, 1200)}`);
  }

  const outText = extractAnyTextFromResponsesApi(data);
  if (!outText) {
    throw new Error("OpenAI response had no extractable text (output_text/content empty).");
  }

  return outText;
}

async function generateQuiz({ language, sourceText, options }) {
  // pentru stabilitate: MCQ only
  const numberOfQuestions = safeNumber(options?.numberOfQuestions, 10);
  const difficulty = options?.difficulty || "medium";

  // Limităm textul trimis către AI (evită prompt prea mare)
  const MAX_SOURCE_CHARS = 18000;
  const trimmedSource =
    (sourceText || "").length > MAX_SOURCE_CHARS
      ? (sourceText || "").slice(0, MAX_SOURCE_CHARS) + "\n\n[NOTE: Source was truncated.]"
      : (sourceText || "");

  // STRICT SCHEMA (MCQ ONLY)
  // IMPORTANT: required include TOATE cheile din properties (in strict mode)
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "questions"],
    properties: {
      title: { type: "string" },
      questions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "question", "choices", "answer", "explanation"],
          properties: {
            type: { type: "string", enum: ["mcq"] },
            question: { type: "string" },
            choices: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
            },
            answer: { type: "string" },
            explanation: { type: "string" },
          },
        },
      },
    },
  };

  const systemPrompt =
    "Return ONLY valid JSON matching the provided JSON schema. " +
    "No markdown. No extra text. " +
    "All content must be strictly in the requested language. " +
    "Keep explanations short (1-2 sentences).";

  const userPrompt = `
LANGUAGE: ${language}
NUMBER_OF_QUESTIONS: ${numberOfQuestions}
DIFFICULTY: ${difficulty}

Generate multiple-choice questions ONLY.
- Provide 4 choices for each question.
- The 'answer' must match one of the choices exactly.

Use ONLY the source text. Do not invent outside facts.

SOURCE TEXT:
<<<
${trimmedSource}
>>>
`;

  const input = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // First try
  const out1 = await openaiCall({ input, schema });

  try {
    return JSON.parse(out1);
  } catch {
    // Repair once (rare)
    const repairInput = [
      { role: "system", content: "Return ONLY valid JSON matching the schema. No extra text." },
      { role: "user", content: `Fix into valid JSON only:\n\n${out1}` },
    ];
    const out2 = await openaiCall({ input: repairInput, schema });
    return JSON.parse(out2);
  }
}

// ------------------- UPLOAD -------------------
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
});

// ------------------- ROUTES -------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/quiz/pdf", uploadPdf.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing PDF file" });
    if (file.mimetype !== "application/pdf") return res.status(400).json({ error: "File is not a PDF" });

    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = safeNumber(req.body.numberOfQuestions, 10);
    const difficulty = req.body.difficulty || "medium";

    const parsed = await pdfParse(file.buffer);
    const text = (parsed.text || "").trim();
    if (!text) return res.status(400).json({ error: "Could not extract text from PDF" });

    // (opțional) chunking — aici doar reconstruim într-un singur text
    const chunks = chunkText(text, 6000);
    const sourceText = chunks.join("\n\n");

    const quiz = await generateQuiz({
      language,
      sourceText,
      options: { numberOfQuestions, difficulty },
    });

    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/quiz/images", uploadImages.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Missing images" });

    let text = "";
    for (const f of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.mimetype)) {
        return res.status(400).json({ error: "Invalid image type (use jpg/png/webp)" });
      }

      // OCR (eng default). Dacă vrei română, putem seta "ron", dar tesseract pe server
      // are nevoie să existe limba instalată; pe Render de obicei nu e.
      const r = await Tesseract.recognize(f.buffer, "eng");
      text += "\n" + (r.data.text || "");
    }

    text = text.trim();
    if (!text) return res.status(400).json({ error: "OCR produced no text" });

    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = safeNumber(req.body.numberOfQuestions, 10);
    const difficulty = req.body.difficulty || "medium";

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
    });

    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ------------------- START -------------------
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log("Quiz API running on port", port));
