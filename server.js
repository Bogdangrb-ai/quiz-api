import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import { createClient } from "@supabase/supabase-js";

/* ===================== APP ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ===================== ENV CHECK ===================== */
function need(name) {
  if (!process.env[name]) {
    throw new Error(`Missing env var: ${name}`);
  }
}

need("OPENAI_API_KEY");
need("SUPABASE_URL");
need("SUPABASE_SERVICE_ROLE_KEY");

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

/* ===================== HELPERS ===================== */
const normalizeLang = (v) => (v || "ro").toLowerCase();
const normalizeDiff = (v) =>
  ["easy", "usor"].includes(v) ? "easy" :
  ["hard", "greu"].includes(v) ? "hard" : "medium";

const normalizeUser = (v) =>
  v && v.trim() ? v.trim() : "guest_" + Math.random().toString(36).slice(2, 10);

/* ===================== OPENAI ===================== */
async function callOpenAI(prompt) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.85,
      max_output_tokens: 3000,
      input: prompt,
    }),
  });

  const t = await r.text();
  if (!r.ok) throw new Error(t);

  const j = JSON.parse(t);
  return j.output_text || "";
}

/* ===================== PROMPT ===================== */
function buildPrompt({ lang, text, subject, topic, diff, index }) {
  return `
LIMBA: ${lang}
DIFICULTATE: ${diff}
QUIZ INDEX: ${index}

Creează un quiz de nivel EXAMEN.
Întrebările trebuie să fie diferite de quizurile anterioare.

FORMAT STRICT JSON:
{
  "title": "Titlu",
  "questions": [
    {
      "question": "...",
      "choices": ["A", "B", "C"],
      "answer": "A",
      "explanation": "Explicație clară și coerentă."
    }
  ]
}

SUBIECT: ${subject || "din text"}
TEMĂ: ${topic || "general"}

TEXT:
<<<
${text || ""}
>>>
`;
}

/* ===================== GENERATE ===================== */
async function generateQuiz(opts) {
  const raw = await callOpenAI(buildPrompt(opts));
  return JSON.parse(raw);
}

/* ===================== SAVE ===================== */
async function saveQuiz(user_id, quiz, meta) {
  const { data, error } = await supabase
    .from("quizzes")
    .insert([{ user_id, title: quiz.title, ...meta }])
    .select("id")
    .single();

  if (error) throw error;

  const rows = quiz.questions.map((q, i) => ({
    quiz_id: data.id,
    position: i + 1,
    type: "mcq",
    question: q.question,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation,
  }));

  await supabase.from("questions").insert(rows);
  return data.id;
}

/* ===================== ROUTES ===================== */
app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/quiz/pdf", uploadPdf.single("file"), async (req, res) => {
  try {
    const parsed = await pdfParse(req.file.buffer);
    const user = normalizeUser(req.body.user_id);

    const quiz = await generateQuiz({
      lang: normalizeLang(req.body.language),
      diff: normalizeDiff(req.body.difficulty),
      subject: req.body.subject,
      topic: req.body.topic,
      text: parsed.text,
      index: Number(req.body.quizIndex || 1),
    });

    const id = await saveQuiz(user, quiz, {
      language: req.body.language,
      source_type: "pdf",
    });

    res.json({ quiz_id: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== START ===================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log("✅ Quiz API running on", PORT)
);
