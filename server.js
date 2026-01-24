require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");

const app = express();

// =================== CONFIG ===================
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function needEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

function normalizeLanguage(lang) {
  if (!lang || typeof lang !== "string") return "en";
  const v = lang.trim();
  return v ? v : "en";
}

function chunkText(text, size = 6000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// =================== OPENAI ===================
Eroare: HTTP 500. Răspuns: {"error":"Unexpected end of JSON input"}

  const systemPrompt =
    "Output ONLY valid JSON matching the provided JSON schema. " +
    "No markdown, no extra text. " +
    "All content must be strictly in the requested language. " +
    "Keep explanations short (1-2 sentences).";

  const userPrompt = `
LANGUAGE: ${language}
NUMBER_OF_QUESTIONS: ${numberOfQuestions}
DIFFICULTY: ${difficulty}
QUESTION_TYPES: ${Array.isArray(questionTypes) ? questionTypes.join(",") : questionTypes}

Use ONLY the source text. Do not invent outside facts.

SOURCE TEXT:
<<<
${trimmedSource}
>>>
`;

  async function callOnce(extraUserText) {
    const input = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt + (extraUserText ? "\n\n" + extraUserText : "") },
    ];

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_output_tokens: 2500, // 2) îi dăm spațiu să nu taie JSON-ul
        input,
        text: {
          format: {
            type: "json_schema",
            name: "quiz",
            strict: true,
            schema
          }
        }
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`OpenAI error ${resp.status}: ${t}`);
    }

    const data = await resp.json();
    const outText =
      data.output_text ||
      (data.output?.[0]?.content?.[0]?.text ?? "");

    return String(outText || "");
  }

  // Prima încercare
  const out1 = await callOnce("");

  if (!out1.trim()) {
    throw new Error("OpenAI returned empty output text.");
  }

  try {
    return JSON.parse(out1);
  } catch (e) {
    // 3) Repair automat dacă JSON-ul e incomplet/tăiat
    const out2 = await callOnce(
      "The previous output was invalid JSON. Return ONLY valid JSON matching the schema. " +
      "Here is the invalid output to fix:\n\n" + out1
    );

    if (!out2.trim()) {
      throw new Error("OpenAI returned empty output text on JSON repair.");
    }

    return JSON.parse(out2);
  }
}

  const data = await response.json();
  const outText =
    data.output_text ||
    (data.output?.[0]?.content?.[0]?.text ?? "");

  if (!outText || !String(outText).trim()) {
    throw new Error("OpenAI returned empty output text.");
  }

  return JSON.parse(outText);
}


SOURCE TEXT:
<<<
${sourceText}
>>>
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const t = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${t}`);
  }

  const data = await response.json();
  const text = data.output_text || "";

  try {
    return JSON.parse(text);
  } catch {
    // retry once to fix JSON
    const fix = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [
          { role: "system", content: "Return ONLY valid JSON." },
          { role: "user", content: `Fix to valid JSON only:\n\n${text}` },
        ],
      }),
    });

    if (!fix.ok) {
      const t2 = await fix.text();
      throw new Error(`OpenAI JSON-fix error ${fix.status}: ${t2}`);
    }

    const fixData = await fix.json();
    return JSON.parse(fixData.output_text || "");
  }
}

// =================== UPLOAD ===================
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 }, // 10 images
});

// =================== ROUTES ===================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// PDF → Quiz
app.post("/api/quiz/pdf", uploadPdf.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing PDF file" });
    if (file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "File is not a PDF" });
    }

    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = Number(req.body.numberOfQuestions || 10);
    const difficulty = req.body.difficulty || "medium";
    const questionTypes = (req.body.questionTypes || "mcq")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const parsed = await pdfParse(file.buffer);
    const text = (parsed.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Could not extract text from PDF" });
    }

    const chunks = chunkText(text, 6000);
    const sourceText = chunks.join("\n\n");

    const quiz = await generateQuiz({
      language,
      sourceText,
      options: { numberOfQuestions, difficulty, questionTypes },
    });

    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Images → OCR → Quiz
app.post("/api/quiz/images", uploadImages.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "Missing images" });
    }

    let text = "";
    for (const f of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.mimetype)) {
        return res.status(400).json({ error: "Invalid image type" });
      }
      const r = await Tesseract.recognize(f.buffer, "eng");
      text += "\n" + (r.data.text || "");
    }

    text = text.trim();
    if (!text) {
      return res.status(400).json({ error: "OCR produced no text" });
    }

    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = Number(req.body.numberOfQuestions || 10);
    const difficulty = req.body.difficulty || "medium";
    const questionTypes = (req.body.questionTypes || "mcq")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty, questionTypes },
    });

    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// =================== START ===================
const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log("Quiz API running on port", port);
});
