require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* ===================== CONFIG ===================== */
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function needEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

needEnv("OPENAI_API_KEY");
needEnv("SUPABASE_URL");
needEnv("SUPABASE_SERVICE_ROLE_KEY");

/* ===================== SUPABASE ===================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/* ===================== UPLOAD ===================== */
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
});

/* ===================== HELPERS ===================== */
function normalizeLanguage(lang) {
  if (!lang) return "ro";
  return String(lang).toLowerCase().trim() || "ro";
}

function normalizeDifficulty(v) {
  const s = String(v || "").toLowerCase();
  if (["easy", "usor", "ușor"].includes(s)) return "easy";
  if (["hard", "greu"].includes(s)) return "hard";
  return "medium";
}

function normalizeUserId(v) {
  const s = String(v || "").trim();
  return s || ("ro_guest_" + Math.random().toString(36).slice(2, 10));
}

/* ===================== OPENAI ===================== */
async function callOpenAI(prompt) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.8,
      max_output_tokens: 3000,
      input: prompt,
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(text);
  }

  const data = JSON.parse(text);
  return data.output_text || "";
}

/* ===================== PROMPT ===================== */
function buildPrompt({
  language,
  sourceText,
  subject,
  topic,
  level,
  difficulty,
  numberOfQuestions,
  quizIndex,
}) {
  return `
Ești un profesor foarte bun, exigent și clar în explicații.
Creezi quiz-uri de nivel examen, care testează înțelegerea reală.

LIMBA: ${language}
NIVEL: ${level}
DIFICULTATE: ${difficulty}
NUMĂR ÎNTREBĂRI: ${numberOfQuestions}
QUIZ INDEX: ${quizIndex}

MATERIE: ${subject || "din text"}
SUBIECT: ${topic || "general"}

REGULI:
- EXACT ${numberOfQuestions} întrebări
- FIECARE întrebare are EXACT 3 variante
- DOAR o explicație clară și mai detaliată
- FĂRĂ texte inutile
- FĂRĂ engleză dacă limba este română
- NU repeta idei între întrebări
- Crește dificultatea progresiv dacă quizIndex > 1

FORMAT OBLIGATORIU (JSON PUR):
{
  "title": "Titlu quiz",
  "questions": [
    {
      "question": "Întrebare clară",
      "choices": ["A", "B", "C"],
      "answer": "A",
      "explanation": "Explicație clară, coerentă și suficient de detaliată pentru a înțelege conceptul."
    }
  ]
}

TEXT SURSĂ (dacă există):
<<<
${sourceText || ""}
>>>
`;
}

/* ===================== GENERATE QUIZ ===================== */
async function generateQuiz(opts) {
  const prompt = buildPrompt(opts);
  const raw = await callOpenAI(prompt);

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("OpenAI a returnat JSON invalid.");
  }
}

/* ===================== SAVE QUIZ ===================== */
async function saveQuiz({ user_id, quiz, meta }) {
  const { data: qRow, error: qErr } = await supabase
    .from("quizzes")
    .insert([{
      user_id,
      title: quiz.title,
      language: meta.language,
      source_type: meta.source_type,
      source_meta: meta.source_meta,
      settings: meta.settings,
    }])
    .select("id")
    .single();

  if (qErr) throw new Error(qErr.message);

  const quiz_id = qRow.id;

  const rows = quiz.questions.map((q, i) => ({
    quiz_id,
    position: i + 1,
    type: "mcq",
    question: q.question,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation,
  }));

  const { error: qsErr } = await supabase.from("questions").insert(rows);
  if (qsErr) throw new Error(qsErr.message);

  return quiz_id;
}

/* ===================== ROUTES ===================== */
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/* ===== PDF ===== */
app.post("/api/quiz/pdf", uploadPdf.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing PDF" });

    const parsed = await pdfParse(file.buffer);
    if (!parsed.text) throw new Error("Nu s-a putut extrage textul.");

    const user_id = normalizeUserId(req.body.user_id);
    const language = normalizeLanguage(req.body.language);
    const difficulty = normalizeDifficulty(req.body.difficulty);

    const quiz = await generateQuiz({
      language,
      sourceText: parsed.text,
      subject: req.body.subject,
      topic: req.body.topic,
      level: req.body.level || "general",
      difficulty,
      numberOfQuestions: 10,
      quizIndex: Number(req.body.quizIndex || 1),
    });

    const quiz_id = await saveQuiz({
      user_id,
      quiz,
      meta: {
        language,
        source_type: "pdf",
        source_meta: { filename: file.originalname },
        settings: { difficulty, numberOfQuestions: 10 },
      },
    });

    res.json({ quiz_id, quiz });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===== TOPIC ===== */
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const user_id = normalizeUserId(req.body.user_id);
    const language = normalizeLanguage(req.body.language);
    const difficulty = normalizeDifficulty(req.body.difficulty);

    const quiz = await generateQuiz({
      language,
      sourceText: "",
      subject: req.body.subject,
      topic: req.body.topic,
      level: req.body.level || "general",
      difficulty,
      numberOfQuestions: 10,
      quizIndex: Number(req.body.quizIndex || 1),
    });

    const quiz_id = await saveQuiz({
      user_id,
      quiz,
      meta: {
        language,
        source_type: "topic",
        source_meta: { subject: req.body.subject, topic: req.body.topic },
        settings: { difficulty, numberOfQuestions: 10 },
      },
    });

    res.json({ quiz_id, quiz });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== START ===================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("✅ SmartQuiz API running on port", PORT);
});
