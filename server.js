/**
 * SmartQuiz API — server.js (cap-coadă)
 * - Express API
 * - Supabase DB
 * - PDF upload + text extraction => saves source_text
 * - Topic mode => generates questions
 * - "regen same theme" for PDF/images via saved source_text (no reupload)
 *
 * ENV required on Render:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   AI_PROVIDER = "openai" (optional)
 *   OPENAI_API_KEY (if you implement OpenAI call)
 *   PORT (Render sets it)
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import pdfParse from "pdf-parse";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* =========================
   Helpers
========================= */

function nowISO() {
  return new Date().toISOString();
}

function safeStr(x) {
  return (x ?? "").toString();
}

function normalizeLang(lang) {
  const v = safeStr(lang).toLowerCase();
  if (["ro", "en", "fr", "de", "es", "it"].includes(v)) return v;
  return "ro";
}

function normalizeDifficulty(d) {
  const v = safeStr(d).toLowerCase();
  if (["easy", "medium", "hard"].includes(v)) return v;
  return "medium";
}

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(n, 10);
  if (Number.isFinite(x)) return Math.min(max, Math.max(min, x));
  return fallback;
}

function makeTitleFromMeta(meta) {
  const subject = safeStr(meta.subject).trim();
  const topic = safeStr(meta.topic).trim();
  if (subject && topic) return `Întrebări despre ${subject} — ${topic}`;
  if (subject) return `Întrebări despre ${subject}`;
  return `Quiz ${new Date().toLocaleDateString()}`;
}

/**
 * IMPORTANT:
 * Aici pui AI-ul tău real.
 * Returnează array de întrebări:
 * [{ type:"mcq", question, choices:[a,b,c], answer:"...", explanation:"...", idx:0 }, ...]
 *
 * Cerință ta: quiz-uri diferite între ele => folosește "seed" random în prompt (ex: Math.random()).
 */
async function generateQuestionsWithAI({
  language,
  difficulty,
  numberOfQuestions,
  questionType,
  contextText, // text extras din pdf OR descriere topic
  meta,
}) {
  // === IMPLEMENTARE DEMO (safe fallback) ===
  // IMPORTANT: în producție înlocuiește cu OpenAI/LLM.
  // Îți dau 10 întrebări simple ca să nu crape flow-ul.
  const n = numberOfQuestions || 10;
  const lang = normalizeLang(language);

  const base = [];
  for (let i = 0; i < n; i++) {
    base.push({
      type: "mcq",
      question:
        lang === "ro"
          ? `Întrebarea ${i + 1}: (demo) Din context, care afirmație este corectă?`
          : `Question ${i + 1}: (demo) Which statement is correct?`,
      choices: lang === "ro" ? ["Varianta A", "Varianta B", "Varianta C"] : ["Option A", "Option B", "Option C"],
      answer: lang === "ro" ? "Varianta A" : "Option A",
      explanation:
        lang === "ro"
          ? "Explicație (demo). Înlocuiește funcția generateQuestionsWithAI cu AI real pentru explicații detaliate."
          : "Explanation (demo). Replace generateQuestionsWithAI with your real AI provider.",
      idx: i,
    });
  }
  return base;
}

/* =========================
   DB functions
========================= */

async function insertQuiz({ user_id, title, language, source_type, source_meta, settings, source_text }) {
  const payload = {
    user_id,
    title,
    language,
    source_type,
    source_meta: source_meta || {},
    settings: settings || {},
    source_text: source_text || null,
    created_at: nowISO(),
  };

  const { data, error } = await supabase.from("quizzes").insert(payload).select("*").single();
  if (error) throw error;
  return data;
}

async function insertQuestions({ quiz_id, questions }) {
  const rows = (questions || []).map((q) => ({
    quiz_id,
    type: q.type || "mcq",
    question: q.question || "",
    choices: q.choices || [],
    answer: q.answer || "",
    explanation: q.explanation || "",
    idx: Number.isFinite(q.idx) ? q.idx : null,
    // dacă ai și column "position" în unele DB-uri, NU o punem aici
    created_at: nowISO(),
  }));

  // IMPORTANT: dacă ai constraint NOT NULL pe idx, asigură idx mereu
  rows.forEach((r, i) => {
    if (r.idx === null || r.idx === undefined) r.idx = i;
  });

  const { error } = await supabase.from("questions").insert(rows);
  if (error) throw error;
}

async function getQuizWithQuestions(quiz_id) {
  const { data: quiz, error: qErr } = await supabase
    .from("quizzes")
    .select("*")
    .eq("id", quiz_id)
    .single();

  if (qErr) throw qErr;

  const { data: questions, error: qqErr } = await supabase
    .from("questions")
    .select("*")
    .eq("quiz_id", quiz_id)
    .order("idx", { ascending: true });

  if (qqErr) throw qqErr;

  return { quiz, questions };
}

async function listQuizzesForUser(user_id) {
  // dacă ai deja view/funcții cu best_score etc, poți adapta aici.
  const { data, error } = await supabase
    .from("quizzes")
    .select("id,user_id,title,language,source_type,source_meta,settings,created_at")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) throw error;

  // încercări/best/last pot veni din altă tabelă; momentan le lăsăm null
  return (data || []).map((q) => ({
    ...q,
    attempts_count: null,
    best_score: null,
    best_total: null,
    last_score: null,
    last_total: null,
  }));
}

/* =========================
   Routes
========================= */

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * GET /api/quizzes?user_id=...
 */
app.get("/api/quizzes", async (req, res) => {
  try {
    const user_id = safeStr(req.query.user_id).trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const quizzes = await listQuizzesForUser(user_id);
    res.json({ quizzes });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * GET /api/quizzes/:id
 */
app.get("/api/quizzes/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await getQuizWithQuestions(id);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * POST /api/quiz/topic
 * body: { user_id, language, difficulty, numberOfQuestions, subject, profile?, topic?, ...meta }
 */
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const body = req.body || {};
    const user_id = safeStr(body.user_id).trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const language = normalizeLang(body.language);
    const difficulty = normalizeDifficulty(body.difficulty);
    const numberOfQuestions = clampInt(body.numberOfQuestions, 5, 30, 10);
    const questionType = safeStr(body.questionType || "mcq3");

    const subject = safeStr(body.subject).trim();
    const profile = safeStr(body.profile).trim();
    const topic = safeStr(body.topic).trim();

    if (!subject) return res.status(400).json({ error: "Missing subject" });

    const meta = { ...body, language, difficulty, numberOfQuestions, questionType };

    // context pentru AI:
    const contextText = [
      `MODE: TOPIC`,
      `SUBJECT: ${subject}`,
      profile ? `PROFILE: ${profile}` : "",
      topic ? `TOPIC: ${topic}` : "",
      `LEVEL: ${safeStr(body.level || "")}`,
      `CLASS_YEAR: ${safeStr(body.classYear || "")}`,
      `FACULTY_YEAR: ${safeStr(body.facultyYear || "")}`,
      `MASTER_YEAR: ${safeStr(body.masterYear || "")}`,
      `PHD_YEAR: ${safeStr(body.phdYear || "")}`,
      `INSTITUTION: ${safeStr(body.institution || "")}`,
    ]
      .filter(Boolean)
      .join("\n");

    const questions = await generateQuestionsWithAI({
      language,
      difficulty,
      numberOfQuestions,
      questionType,
      contextText,
      meta,
    });

    const quiz = await insertQuiz({
      user_id,
      title: makeTitleFromMeta({ subject, topic }),
      language,
      source_type: "topic",
      source_meta: {
        subject,
        profile,
        topic,
      },
      settings: {
        difficulty,
        numberOfQuestions,
        questionType,
      },
      source_text: contextText, // pentru topic salvăm contextul ca "source_text"
    });

    await insertQuestions({ quiz_id: quiz.id, questions });

    res.json({ quiz_id: quiz.id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * POST /api/quiz/pdf
 * multipart/form-data:
 *  - file: PDF
 *  - user_id, language, difficulty, numberOfQuestions, etc...
 */
app.post("/api/quiz/pdf", upload.single("file"), async (req, res) => {
  try {
    const user_id = safeStr(req.body.user_id).trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!req.file) return res.status(400).json({ error: "Missing PDF file" });

    const language = normalizeLang(req.body.language);
    const difficulty = normalizeDifficulty(req.body.difficulty);
    const numberOfQuestions = clampInt(req.body.numberOfQuestions, 5, 30, 10);
    const questionType = safeStr(req.body.questionType || "mcq3");

    // 1) extract text from PDF
    const parsed = await pdfParse(req.file.buffer);
    const extractedText = safeStr(parsed.text).trim();

    if (!extractedText) {
      return res.status(400).json({ error: "Nu am putut extrage text din PDF. Încearcă alt PDF." });
    }

    // 2) meta
    const meta = {
      ...req.body,
      user_id,
      language,
      difficulty,
      numberOfQuestions,
      questionType,
    };

    // 3) AI generate based on extractedText + meta
    const contextText = extractedText.slice(0, 200000); // safety cap
    const questions = await generateQuestionsWithAI({
      language,
      difficulty,
      numberOfQuestions,
      questionType,
      contextText,
      meta,
    });

    // 4) save quiz + source_text (IMPORTANT)
    const quiz = await insertQuiz({
      user_id,
      title: safeStr(req.body.title).trim() || `Întrebări din ${req.file.originalname}`,
      language,
      source_type: "pdf",
      source_meta: {
        filename: req.file.originalname,
        size: req.file.size,
      },
      settings: { difficulty, numberOfQuestions, questionType },
      source_text: contextText, // ✅ AICI e cheia pentru "Alt quiz pe aceeași temă"
    });

    await insertQuestions({ quiz_id: quiz.id, questions });

    res.json({ quiz_id: quiz.id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * POST /api/quiz/regen/:quiz_id
 * Regenerează alt quiz pe aceeași temă:
 * - dacă source_type=topic => folosește source_text (contextul topic)
 * - dacă source_type=pdf/images => folosește source_text (textul salvat)
 */
app.post("/api/quiz/regen/:quiz_id", async (req, res) => {
  try {
    const quiz_id = req.params.quiz_id;
    const { quiz } = await getQuizWithQuestions(quiz_id);

    const user_id = quiz.user_id;
    const language = normalizeLang(req.body?.language || quiz.language);
    const settings = quiz.settings || {};
    const difficulty = normalizeDifficulty(req.body?.difficulty || settings.difficulty);
    const numberOfQuestions = clampInt(req.body?.numberOfQuestions || settings.numberOfQuestions, 5, 30, 10);
    const questionType = safeStr(req.body?.questionType || settings.questionType || "mcq3");

    const sourceText = safeStr(quiz.source_text).trim();
    if (!sourceText) {
      return res.status(400).json({
        error:
          "Nu există source_text salvat pentru acest quiz. Generează din nou quiz-ul (după ce ai aplicat migrarea) ca să se salveze textul.",
      });
    }

    const meta = {
      from_quiz_id: quiz_id,
      source_type: quiz.source_type,
      source_meta: quiz.source_meta || {},
      settings: { difficulty, numberOfQuestions, questionType },
    };

    // random salt ca să fie diferit
    const salt = `\n\nRANDOM_SEED: ${Math.random().toString(36).slice(2)}\n`;
    const contextText = sourceText + salt;

    const questions = await generateQuestionsWithAI({
      language,
      difficulty,
      numberOfQuestions,
      questionType,
      contextText,
      meta,
    });

    const newQuiz = await insertQuiz({
      user_id,
      title: `${safeStr(quiz.title || "Quiz")} (nou)`,
      language,
      source_type: quiz.source_type,
      source_meta: quiz.source_meta || {},
      settings: { difficulty, numberOfQuestions, questionType },
      source_text: sourceText, // păstrăm original, fără salt în DB
    });

    await insertQuestions({ quiz_id: newQuiz.id, questions });

    res.json({ quiz_id: newQuiz.id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SmartQuiz API running on port", PORT));
