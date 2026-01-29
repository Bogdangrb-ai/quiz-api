require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ------------------- CONFIG -------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

function needEnv(name) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDifficulty(v) {
  const s = String(v || "").toLowerCase().trim();
  if (["easy", "usor", "ușor"].includes(s)) return "easy";
  if (["hard", "greu"].includes(s)) return "hard";
  return "medium";
}

// ✅ NORMALIZARE LIMBĂ STRICTĂ
function normalizeLanguage(lang) {
  const s = String(lang || "").trim().toLowerCase();
  const allowed = new Set(["ro","en","fr","de","es","it","pt","nl","pl","tr","uk","ru","ar","he","fa","ur","hi","zh","ja","ko"]);
  if (allowed.has(s)) return s;
  return "ro"; // default: română pentru site-ul RO
}

// ------------------- SUPABASE -------------------
needEnv("SUPABASE_URL");
needEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function normalizeUserId(v) {
  const s = String(v || "").trim();
  return s || ("ro_guest_" + Math.random().toString(36).slice(2, 10));
}

// ------------------- OPENAI (Responses API) -------------------
function extractAnyTextFromResponsesApi(data) {
  if (!data) return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

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
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${rawBody.slice(0, 1400)}`);

  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`OpenAI returned non-JSON body: ${rawBody.slice(0, 1400)}`); }

  const outText = extractAnyTextFromResponsesApi(data);
  if (!outText) throw new Error("OpenAI response had no extractable text.");
  return outText;
}

function looksLikeLanguage(text, lang) {
  // euristic simplu: dacă user a cerut RO și primele 500 caractere au multe cuvinte engleze, respingem
  const t = String(text || "").slice(0, 600).toLowerCase();
  if (lang === "ro") {
    const enHits = [" the ", " and ", " of ", " is ", " are ", "which", "what", "when", "where", "explanation"];
    const hits = enHits.reduce((acc,w)=> acc + (t.includes(w) ? 1 : 0), 0);
    return hits <= 2;
  }
  return true; // pentru restul nu blocăm acum
}

async function generateQuiz({ language, sourceText, options, extraMeta }) {
  const numberOfQuestions = safeNumber(options?.numberOfQuestions, 10);
  const difficulty = normalizeDifficulty(options?.difficulty || "medium");

  const MAX_SOURCE_CHARS = 18000;
  const trimmedSource =
    (sourceText || "").length > MAX_SOURCE_CHARS
      ? (sourceText || "").slice(0, MAX_SOURCE_CHARS) + "\n\n[NOTE: Source was truncated.]"
      : (sourceText || "");

  // ✅ STRICT SCHEMA + language inclus ca validare
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "language", "questions"],
    properties: {
      title: { type: "string" },
      language: { type: "string", enum: [language] },
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
            choices: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
            answer: { type: "string" },
            explanation: { type: "string" },
          },
        },
      },
    },
  };

  // ✅ Meta de context (facultate/materie etc.) — ajută, dar NU e obligatoriu
  const metaBlock = extraMeta
    ? `
CONTEXT (may help you write better questions, but do NOT invent facts):
- level: ${extraMeta.level || ""}
- classYear: ${extraMeta.classYear || ""}
- facultyYear: ${extraMeta.facultyYear || ""}
- masterYear: ${extraMeta.masterYear || ""}
- phdYear: ${extraMeta.phdYear || ""}
- institution: ${extraMeta.institution || ""}
- subject: ${extraMeta.subject || ""}
- profile: ${extraMeta.profile || ""}
- topic: ${extraMeta.topic || ""}
`
    : "";

  const systemPrompt =
    "You return ONLY valid JSON that matches the provided JSON schema. " +
    "No markdown. No extra text. " +
    "CRITICAL: Write EVERYTHING strictly in the requested language. " +
    "If the user requested Romanian (ro), do NOT output English.";

  const userPrompt = `
LANGUAGE: ${language}
DIFFICULTY: ${difficulty}
NUMBER_OF_QUESTIONS: ${numberOfQuestions}

Rules:
- Output language MUST be exactly: ${language}
- Multiple choice ONLY: 3 choices per question (exactly 3).
- 'answer' MUST match one of the choices exactly.
- Use ONLY the source text. Do not invent outside facts.
- Keep explanations short (1-2 sentences).

${metaBlock}

SOURCE TEXT:
<<<
${trimmedSource}
>>>
`;

  const input = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const out1 = await openaiCall({ input, schema });

  // ✅ parse + fallback repair
  let parsed;
  try { parsed = JSON.parse(out1); }
  catch {
    const repairInput = [
      { role: "system", content: "Return ONLY valid JSON matching the schema. No extra text." },
      { role: "user", content: `Fix into valid JSON only:\n\n${out1}` },
    ];
    const out2 = await openaiCall({ input: repairInput, schema });
    parsed = JSON.parse(out2);
  }

  // ✅ verificare limbă (doar pentru ro, ca să nu mai iasă EN)
  if (!looksLikeLanguage(JSON.stringify(parsed), language)) {
    const retryInput = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt + "\n\nIMPORTANT: Your previous output was not in the requested language. Regenerate in the correct language ONLY." },
    ];
    const outRetry = await openaiCall({ input: retryInput, schema });
    parsed = JSON.parse(outRetry);
  }

  return parsed;
}

// ------------------- DB SAVE HELPERS -------------------
async function saveQuizToDb({ user_id, title, language, source_type, source_meta, settings, questions }) {
  const { data: quizRow, error: qErr } = await supabase
    .from("quizzes")
    .insert([{ user_id, title, language, source_type, source_meta: source_meta || {}, settings: settings || {} }])
    .select("id")
    .single();

  if (qErr) throw new Error(qErr.message);

  const quiz_id = quizRow.id;

  const rows = (questions || []).map((q, idx) => ({
    quiz_id,
    idx,                  // ✅ folosim idx (cum ai în DB)
    type: q.type || "mcq",
    question: q.question || "",
    choices: q.choices || [],
    answer: q.answer || "",
    explanation: q.explanation || "",
  }));

  const { error: qsErr } = await supabase.from("questions").insert(rows);
  if (qsErr) throw new Error(qsErr.message);

  return quiz_id;
}

// ------------------- UPLOAD -------------------
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const uploadImages = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10 } });

// ------------------- ROUTES -------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/quizzes", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data, error } = await supabase
      .from("quizzes")
      .select("id,title,language,source_type,source_meta,settings,created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);
    res.json({ quizzes: data || [] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/quizzes/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const { data: quiz, error: qErr } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", id)
      .single();

    if (qErr) throw new Error(qErr.message);

    const { data: questions, error: qsErr } = await supabase
      .from("questions")
      .select("id,type,question,choices,answer,explanation,idx")
      .eq("quiz_id", id)
      .order("idx", { ascending: true });

    if (qsErr) throw new Error(qsErr.message);

    res.json({ quiz, questions: questions || [] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// PDF -> generate -> save -> return
app.post("/api/quiz/pdf", uploadPdf.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing PDF file" });
    if (file.mimetype !== "application/pdf") return res.status(400).json({ error: "File is not a PDF" });

    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = safeNumber(req.body.numberOfQuestions, 10);
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");
    const user_id = normalizeUserId(req.body.user_id);

    const parsed = await pdfParse(file.buffer);
    const text = (parsed.text || "").trim();
    if (!text) return res.status(400).json({ error: "Could not extract text from PDF" });

    const extraMeta = {
      level: req.body.level,
      classYear: req.body.classYear,
      facultyYear: req.body.facultyYear,
      masterYear: req.body.masterYear,
      phdYear: req.body.phdYear,
      institution: req.body.institution,
      subject: req.body.subject,
      profile: req.body.profile,
      topic: req.body.topic
    };

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
      extraMeta
    });

    const quiz_id = await saveQuizToDb({
      user_id,
      title: quiz.title || "Quiz",
      language,
      source_type: "pdf",
      source_meta: { filename: file.originalname, size: file.size },
      settings: { numberOfQuestions, difficulty },
      questions: quiz.questions || [],
    });

    res.json({ ...quiz, quiz_id });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Images -> OCR -> generate -> save -> return
app.post("/api/quiz/images", uploadImages.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Missing images" });

    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = safeNumber(req.body.numberOfQuestions, 10);
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");
    const user_id = normalizeUserId(req.body.user_id);

    let text = "";
    for (const f of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.mimetype)) {
        return res.status(400).json({ error: "Invalid image type (use jpg/png/webp)" });
      }
      const r = await Tesseract.recognize(f.buffer, "eng");
      text += "\n" + (r.data.text || "");
    }

    text = text.trim();
    if (!text) return res.status(400).json({ error: "OCR produced no text" });

    const extraMeta = {
      level: req.body.level,
      classYear: req.body.classYear,
      facultyYear: req.body.facultyYear,
      masterYear: req.body.masterYear,
      phdYear: req.body.phdYear,
      institution: req.body.institution,
      subject: req.body.subject,
      profile: req.body.profile,
      topic: req.body.topic
    };

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
      extraMeta
    });

    const quiz_id = await saveQuizToDb({
      user_id,
      title: quiz.title || "Quiz",
      language,
      source_type: "images",
      source_meta: { count: files.length },
      settings: { numberOfQuestions, difficulty },
      questions: quiz.questions || [],
    });

    res.json({ ...quiz, quiz_id });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ------------------- START -------------------
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log("Quiz API running on port", port));
