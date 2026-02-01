/**
 * server.js (ESM) — CAP-COADĂ, gata de lipit
 *
 * Necesită env vars (în Render / Environment):
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - OPENAI_API_KEY
 * - ALLOWED_ORIGIN   (ex: https://smartquizro-com-467810.hostingersite.com)
 * - PORT             (Render o pune singur, local poți pune 10000)
 *
 * Endpoints:
 *  GET  /health
 *  POST /api/quiz/topic      (JSON)
 *  POST /api/quiz/pdf        (multipart/form-data cu fișier PDF)
 *  GET  /api/quizzes/:id
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import pdfParse from "pdf-parse";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ---------- CONFIG ----------
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "*").trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

if (!SUPABASE_URL) console.warn("⚠️ Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("⚠️ Missing SUPABASE_SERVICE_ROLE_KEY");
if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// multer: accept PDF file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024, // 12MB
  },
});

// ---------- MIDDLEWARE ----------
app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl / local dev
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGIN === "*" || origin === ALLOWED_ORIGIN) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: false,
  })
);

app.use(express.json({ limit: "2mb" }));

// ---------- HELPERS ----------
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function safeJsonParseFromModel(raw) {
  if (!raw) throw new Error("Empty AI response");

  let t = String(raw).trim();

  // remove ```json ... ```
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\n?/, "").trim();
    t = t.replace(/\n?```$/g, "").trim();
  }

  // find first JSON start
  const firstArr = t.indexOf("[");
  const firstObj = t.indexOf("{");
  let start = -1;

  if (firstArr === -1) start = firstObj;
  else if (firstObj === -1) start = firstArr;
  else start = Math.min(firstArr, firstObj);

  if (start > 0) t = t.slice(start).trim();

  // cut at last JSON end
  const lastArr = t.lastIndexOf("]");
  const lastObj = t.lastIndexOf("}");
  const end = Math.max(lastArr, lastObj);
  if (end !== -1) t = t.slice(0, end + 1).trim();

  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`AI returned invalid JSON. Preview: ${t.slice(0, 400)}`);
  }
}

function buildQuestionsPrompt({
  language = "ro",
  n = 10,
  difficulty = "mediu",
  topic = "",
  sourceText = "",
}) {
  return `
Ești un generator de quiz-uri foarte strict.

Generează EXACT ${n} întrebări tip grilă (4 variante) despre:
TOPIC: ${topic || "din textul furnizat"}
DIFICULTATE: ${difficulty}
LIMBA: ${language}

REGULI CRITICE:
- Returnează DOAR JSON valid, fără markdown, fără explicații, fără \`\`\`.
- Structura trebuie să fie exact: array de obiecte.
- Fiecare obiect:
  {
    "question": string,
    "choices": [string,string,string,string],
    "answer": string,
    "explanation": string
  }
- "answer" trebuie să fie IDENTIC cu una din "choices".
- Nu pune trailing commas.
- "choices" să fie 4 opțiuni distincte.

TEXT (dacă există):
${sourceText ? sourceText.slice(0, 12000) : "(nu există text)"}
`.trim();
}

function normalizeQuestions(list) {
  if (!Array.isArray(list)) throw new Error("AI JSON must be an array");

  return list.map((q) => {
    const question = String(q?.question || "").trim();
    const choices = Array.isArray(q?.choices) ? q.choices.map((x) => String(x).trim()) : [];
    let answer = String(q?.answer || "").trim();
    const explanation = String(q?.explanation || "").trim();

    // minimal guards
    if (!question) throw new Error("Question missing");
    if (choices.length !== 4) throw new Error("Each question must have 4 choices");

    // make answer match exactly one choice
    if (!choices.includes(answer)) {
      const found = choices.find((c) => c.toLowerCase() === answer.toLowerCase());
      if (found) answer = found;
    }
    if (!choices.includes(answer)) {
      // last resort: force answer as first choice (prevents frontend crash)
      answer = choices[0];
    }

    return { question, choices, answer, explanation };
  });
}

async function generateQuestionsWithOpenAI({
  model = "gpt-4o-mini",
  language = "ro",
  n = 10,
  difficulty = "mediu",
  topic = "",
  sourceText = "",
  temperature = 0.9,
}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const prompt = buildQuestionsPrompt({ language, n, difficulty, topic, sourceText });

  const resp = await openai.responses.create({
    model,
    input: prompt,
    temperature,
  });

  const rawText = resp.output_text || "";
  const parsed = safeJsonParseFromModel(rawText);
  const normalized = normalizeQuestions(parsed);

  return {
    model_used: resp.model || model,
    questions: normalized.slice(0, n),
    raw_preview: rawText.slice(0, 500),
  };
}

async function insertQuizAndQuestions({
  title,
  language,
  difficulty,
  source_type,
  topic,
  source_text,
  questions,
}) {
  // insert quiz
  const { data: quizRow, error: qErr } = await supabase
    .from("quizzes")
    .insert([
      {
        title,
        language,
        difficulty,
        source_type,
        topic,
        source_text,
      },
    ])
    .select("*")
    .single();

  if (qErr) throw new Error(qErr.message);

  // insert questions
  const rows = questions.map((q, idx) => ({
    quiz_id: quizRow.id,
    idx, // IMPORTANT: your table must have idx NOT NULL
    question: q.question,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation,
  }));

  const { error: insErr } = await supabase.from("questions").insert(rows);
  if (insErr) throw new Error(insErr.message);

  return quizRow;
}

// ---------- ROUTES ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "Quiz API running" });
});

/**
 * POST /api/quiz/topic
 * body JSON:
 * {
 *   "topic": "Drept comercial",
 *   "subject": "Comerț și comercianți",
 *   "language": "ro",
 *   "difficulty": "mediu",
 *   "num_questions": 10,
 *   "model": "gpt-4o-mini" (optional)
 * }
 */
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const language = String(req.body?.language || "ro").trim();
    const difficulty = String(req.body?.difficulty || "mediu").trim();
    const num_questions = clampInt(req.body?.num_questions ?? 10, 5, 30);
    const model = String(req.body?.model || "gpt-4o-mini").trim();

    if (!topic) return res.status(400).json({ error: "Missing topic" });

    const finalTopic = subject ? `${topic} — ${subject}` : topic;
    const ai = await generateQuestionsWithOpenAI({
      model,
      language,
      n: num_questions,
      difficulty,
      topic: finalTopic,
      sourceText: "",
      temperature: 0.9,
    });

    const title = subject ? `${topic} - ${subject}` : topic;

    const quizRow = await insertQuizAndQuestions({
      title,
      language,
      difficulty,
      source_type: "topic",
      topic: finalTopic,
      source_text: "",
      questions: ai.questions,
    });

    res.json({
      ok: true,
      quiz_id: quizRow.id,
      model_used: ai.model_used,
      quiz: quizRow,
      questions: ai.questions,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/quiz/pdf
 * multipart/form-data:
 *  - file: PDF
 *  - language (optional)
 *  - difficulty (optional)
 *  - num_questions (optional)
 *  - title (optional)
 *  - model (optional)
 */
app.post("/api/quiz/pdf", upload.any(), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const file = files[0];

    if (!file) return res.status(400).json({ error: "Missing PDF file" });
    if (!String(file.mimetype || "").includes("pdf"))
      return res.status(400).json({ error: "Uploaded file is not a PDF" });

    const language = String(req.body?.language || "ro").trim();
    const difficulty = String(req.body?.difficulty || "mediu").trim();
    const num_questions = clampInt(req.body?.num_questions ?? 10, 5, 30);
    const model = String(req.body?.model || "gpt-4o-mini").trim();

    const titleFromBody = String(req.body?.title || "").trim();
    const titleFromFile = String(file.originalname || "Quiz PDF").replace(/\.pdf$/i, "");
    const title = titleFromBody || titleFromFile || "Quiz PDF";

    // extract text from PDF
    const parsed = await pdfParse(file.buffer);
    const sourceText = String(parsed?.text || "").trim();

    if (!sourceText || sourceText.length < 200) {
      return res.status(400).json({
        error:
          "Nu am putut extrage suficient text din PDF. Încearcă un PDF cu text selectabil (nu doar poze).",
      });
    }

    const ai = await generateQuestionsWithOpenAI({
      model,
      language,
      n: num_questions,
      difficulty,
      topic: title,
      sourceText,
      temperature: 0.9,
    });

    const quizRow = await insertQuizAndQuestions({
      title,
      language,
      difficulty,
      source_type: "pdf",
      topic: title,
      source_text: sourceText,
      questions: ai.questions,
    });

    res.json({
      ok: true,
      quiz_id: quizRow.id,
      model_used: ai.model_used,
      quiz: quizRow,
      questions: ai.questions,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/quizzes/:id
 * returnează quiz + questions (ordonate)
 */
app.get("/api/quizzes/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const { data: quiz, error: qErr } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", id)
      .single();

    if (qErr) return res.status(404).json({ error: qErr.message });

    const { data: questions, error: qsErr } = await supabase
      .from("questions")
      .select("id, quiz_id, idx, question, choices, answer, explanation")
      .eq("quiz_id", id)
      .order("idx", { ascending: true });

    if (qsErr) throw new Error(qsErr.message);

    res.json({ ok: true, quiz, questions: questions || [] });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ Quiz API running on ${PORT}`);
});
