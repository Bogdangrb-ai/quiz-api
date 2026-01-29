/**
 * SmartQuiz API — server.js (cap-coadă)
 * - Express API
 * - Supabase DB (quizzes, questions)
 * - OpenAI Responses API (generare întrebări + OCR/rezumat)
 *
 * Endpoint-uri:
 *   GET  /api/health
 *   GET  /api/quizzes?user_id=...
 *   GET  /api/quizzes/:id
 *   POST /api/quiz/pdf       (multipart: file)
 *   POST /api/quiz/images    (multipart: images[])
 *   POST /api/quiz/topic     (json)
 *   POST /api/quiz/regen     (json: quiz_id) => quiz nou pe aceeași temă, fără reupload (din source_text)
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "6mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in env.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Helpers ----
const API_PREFIX = "/api";
const DEFAULT_MODEL_FAST = "gpt-4o-mini"; // rapid & ieftin
const DEFAULT_MODEL_QUALITY = "gpt-4o";   // mai bun la calitate (poți schimba)

function nowISO() {
  return new Date().toISOString();
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function pickLanguageCode(lang) {
  const v = String(lang || "").toLowerCase().trim();
  if (["ro", "en", "fr", "de", "es", "it"].includes(v)) return v;
  return "ro";
}

function languageName(lang) {
  switch (lang) {
    case "ro": return "Română";
    case "en": return "English";
    case "fr": return "Français";
    case "de": return "Deutsch";
    case "es": return "Español";
    case "it": return "Italiano";
    default: return "Română";
  }
}

function makeTitleFromMeta(meta, sourceType) {
  const subj = (meta?.subject || "").trim();
  const topic = (meta?.topic || "").trim();
  const base = subj ? subj : "Quiz";
  const extra = topic ? ` — ${topic}` : "";
  const st = sourceType ? ` (${sourceType})` : "";
  return `${base}${extra}${st}`;
}

function randTag() {
  return crypto.randomBytes(6).toString("hex"); // pt varietate între quiz-uri
}

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === "") {
      return `Missing field: ${f}`;
    }
  }
  return null;
}

// ---- OpenAI: extract text from PDF bytes (best effort) ----
// Fără librării OCR locale, folosim modelul ca să facă "read & summarize".
// Pentru PDF: trimitem ca "file input" nu e trivial fără Uploads API,
// așa că folosim o abordare sigură: cerem userului doar "quiz din pdf"
// dar aici extragem text printr-o compresie simplă: NU putem citi PDF binar direct ca text.
// => Soluție practică: pentru PDF, îl trimiți la model ca fișier via Uploads/Files (mai complex).
// Ca să rămână "gata de lipit" și stabil, facem fallback:
// - dacă PDF e text-based, încercăm să extragem text minimal cu o decodare (nu mereu).
// - altfel: modelul va genera întrebări mai mult din contextul meta.
// Recomandare: pentru calitate maximă la PDF scannat, ulterior adăugăm pipeline de OCR real.
function tryDecodePdfToText(buffer) {
  // încercare simplă: pentru PDF-uri "text-based" mai prinde bucăți
  const raw = buffer.toString("latin1");
  // scoatem bucăți care arată a text
  const cleaned = raw
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // dacă e prea "gibberish", îl ignorăm
  if (cleaned.length < 500) return "";
  // limităm ca să nu explodeze promptul
  return cleaned.slice(0, 12000);
}

// ---- OpenAI: extract text from images via vision ----
async function extractTextFromImages(imageFiles, lang) {
  // trimitem imagini ca input; modelul răspunde cu text curat (în limba cerută).
  const inputs = [];

  for (const f of imageFiles.slice(0, 10)) {
    const b64 = f.buffer.toString("base64");
    const mime = f.mimetype || "image/jpeg";
    inputs.push({
      type: "input_image",
      image_url: `data:${mime};base64,${b64}`,
    });
  }

  const instruction = `
Ești un extractor de text din imagini pentru învățare.
1) Extrage fidel conținutul (definiții, liste, idei).
2) Curăță-l (fără "header/footer" inutile).
3) Returnează textul într-un singur bloc.
4) Limba de ieșire: ${languageName(lang)}.
`.trim();

  const resp = await openai.responses.create({
    model: DEFAULT_MODEL_FAST,
    instructions: instruction,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extrage textul din imaginile următoare:" },
          ...inputs,
        ],
      },
    ],
    max_output_tokens: 1200,
    temperature: 0.2,
  });

  const out = resp.output_text || "";
  return out.trim();
}

// ---- OpenAI: generate quiz questions as strict JSON ----
async function generateQuestionsFromText({
  sourceText,
  meta,
  previousQuestions = [],
  n = 10,
}) {
  const lang = pickLanguageCode(meta?.language);
  const difficulty = String(meta?.difficulty || "medium");
  const subject = (meta?.subject || "").trim();
  const profile = (meta?.profile || "").trim();
  const topic = (meta?.topic || "").trim();

  const contextBits = [
    subject ? `Materie: ${subject}` : "",
    profile ? `Profil: ${profile}` : "",
    topic ? `Subiect: ${topic}` : "",
    meta?.level ? `Nivel: ${meta.level}` : "",
    meta?.classYear ? `Clasă: ${meta.classYear}` : "",
    meta?.facultyYear ? `An facultate: ${meta.facultyYear}` : "",
    meta?.masterYear ? `Master: anul ${meta.masterYear}` : "",
    meta?.phdYear ? `Doctorat: anul ${meta.phdYear}` : "",
    meta?.institution ? `Instituție: ${meta.institution}` : "",
    `Dificultate: ${difficulty}`,
    `Limba: ${languageName(lang)}`,
  ].filter(Boolean).join("\n");

  const varietyTag = randTag();

  // IMPORTANT: enforce language + format
  const instructions = `
Ești un generator de quiz-uri pentru studiu.
Reguli OBLIGATORII:
- Întrebările și explicațiile trebuie să fie 100% în: ${languageName(lang)}.
- Generează EXACT ${n} întrebări.
- Fiecare întrebare: 3 variante (A/B/C) (stringuri), un singur răspuns corect (exact unul dintre choices).
- Răspunsul "answer" trebuie să fie exact una dintre choices (identic ca text).
- Explicația să fie utilă pentru învățare (1-3 fraze), clară, fără generalități.
- Fă quiz-ul DIFERIT de alte încercări: nu repeta aceleași întrebări dacă se poate.
- Returnează DOAR JSON valid, fără text în plus.

Format JSON exact:
{
  "questions":[
    {"question":"...","choices":["...","...","..."],"answer":"...","explanation":"..."}
  ]
}
`.trim();

  const avoid = previousQuestions.length
    ? `Întrebări anterioare (evită repetiția):\n${previousQuestions
        .slice(0, 30)
        .map((q, i) => `${i + 1}. ${q.question}`)
        .join("\n")}`
    : "";

  const textBlock = (sourceText || "").trim();
  const trimmedSource = textBlock ? textBlock.slice(0, 18000) : "";

  const userPrompt = `
CONTEXT UTILIZATOR:
${contextBits}

TAG VARIETATE (nu îl afișa): ${varietyTag}

${avoid ? avoid + "\n" : ""}

CONȚINUT SURSA (dacă există):
${trimmedSource ? trimmedSource : "(nu există text sursă, folosește doar contextul de mai sus, dar păstrează tema)"}
`.trim();

  const resp = await openai.responses.create({
    model: DEFAULT_MODEL_QUALITY,
    instructions,
    input: userPrompt,
    max_output_tokens: 2200,
    temperature: 0.9, // mai variat, dar păstrăm regulile
  });

  const txt = resp.output_text || "";
  const parsed = safeJsonParse(txt);

  if (!parsed || !Array.isArray(parsed.questions)) {
    throw new Error("Modelul nu a returnat JSON valid pentru întrebări.");
  }

  // normalize
  const questions = parsed.questions.slice(0, n).map((q) => ({
    question: String(q.question || "").trim(),
    choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c)) : [],
    answer: String(q.answer || "").trim(),
    explanation: String(q.explanation || "").trim(),
  }));

  // quick validation
  for (const q of questions) {
    if (!q.question || q.choices.length !== 3) throw new Error("Întrebări invalide (format).");
    if (!q.choices.includes(q.answer)) throw new Error("Răspunsul nu există în choices.");
  }

  return questions;
}

// ---- DB helpers ----
async function insertQuizAndQuestions({
  user_id,
  language,
  source_type,
  source_meta,
  settings,
  source_text,
  questions,
  title,
}) {
  // 1) insert quiz
  const quizRow = {
    user_id,
    title,
    language,
    source_type,
    source_meta: source_meta || {},
    settings: settings || {},
    source_text: source_text || "",
    created_at: nowISO(),
  };

  const { data: quizIns, error: qErr } = await supabase
    .from("quizzes")
    .insert(quizRow)
    .select("*")
    .single();

  if (qErr) throw new Error(qErr.message || "Supabase insert quiz failed.");

  const quiz_id = quizIns.id;

  // 2) insert questions (idx 0..n-1)
  const rows = questions.map((q, i) => ({
    quiz_id,
    idx: i,
    question: q.question,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation,
    created_at: nowISO(),
  }));

  const { error: qsErr } = await supabase.from("questions").insert(rows);
  if (qsErr) throw new Error(qsErr.message || "Supabase insert questions failed.");

  return quiz_id;
}

async function getQuizWithQuestions(quiz_id) {
  const { data: quiz, error: qErr } = await supabase
    .from("quizzes")
    .select("*")
    .eq("id", quiz_id)
    .single();

  if (qErr) throw new Error(qErr.message || "Quiz not found.");

  const { data: questions, error: qsErr } = await supabase
    .from("questions")
    .select("*")
    .eq("quiz_id", quiz_id)
    .order("idx", { ascending: true });

  if (qsErr) throw new Error(qsErr.message || "Questions not found.");

  return { quiz, questions: questions || [] };
}

// ---- Routes ----
app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.json({ ok: true });
});

app.get(`${API_PREFIX}/quizzes`, async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    // list quizzes + small aggregates
    const { data: quizzes, error } = await supabase
      .from("quizzes")
      .select("id,title,language,source_type,source_meta,settings,created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);

    // attempts stats (dacă ai tabel attempts, altfel ignorăm)
    // pentru simplitate, returnăm doar quizzes
    res.json({ quizzes: quizzes || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get(`${API_PREFIX}/quizzes/:id`, async (req, res) => {
  try {
    const quiz_id = req.params.id;
    const data = await getQuizWithQuestions(quiz_id);
    res.json(data);
  } catch (e) {
    res.status(404).json({ error: e.message || String(e) });
  }
});

app.post(`${API_PREFIX}/quiz/topic`, async (req, res) => {
  try {
    const body = req.body || {};
    const miss = requireFields(body, ["user_id", "language", "difficulty", "numberOfQuestions", "subject"]);
    if (miss) return res.status(400).json({ error: miss });

    const meta = {
      user_id: String(body.user_id),
      language: pickLanguageCode(body.language),
      difficulty: String(body.difficulty || "medium"),
      numberOfQuestions: Number(body.numberOfQuestions || 10),
      questionType: String(body.questionType || "mcq3"),
      level: body.level || "",
      institution: body.institution || "",
      classYear: body.classYear || "",
      facultyYear: body.facultyYear || "",
      masterYear: body.masterYear || "",
      phdYear: body.phdYear || "",
      subject: body.subject || "",
      profile: body.profile || "",
      topic: body.topic || "",
    };

    const n = Math.max(1, Math.min(30, meta.numberOfQuestions || 10));

    // "source_text" pentru topic mode = un rezumat clar al contextului
    const sourceText = `
[TOPIC MODE]
Materie: ${meta.subject}
Profil: ${meta.profile || "-"}
Subiect: ${meta.topic || "-"}
Nivel: ${meta.level || "-"}
`.trim();

    const questions = await generateQuestionsFromText({
      sourceText,
      meta,
      previousQuestions: [],
      n,
    });

    const quiz_id = await insertQuizAndQuestions({
      user_id: meta.user_id,
      language: meta.language,
      source_type: "topic",
      source_meta: { mode: "topic" },
      settings: { difficulty: meta.difficulty, numberOfQuestions: n, questionType: meta.questionType, meta },
      source_text: sourceText,
      questions,
      title: makeTitleFromMeta(meta, "topic"),
    });

    res.json({ ok: true, quiz_id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post(`${API_PREFIX}/quiz/pdf`, upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: "file is required" });

    const user_id = String(req.body.user_id || "").trim();
    const language = pickLanguageCode(req.body.language || "ro");
    const difficulty = String(req.body.difficulty || "medium");
    const numberOfQuestions = Number(req.body.numberOfQuestions || 10);

    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const meta = {
      user_id,
      language,
      difficulty,
      numberOfQuestions,
      questionType: String(req.body.questionType || "mcq3"),
      level: String(req.body.level || ""),
      institution: String(req.body.institution || ""),
      classYear: String(req.body.classYear || ""),
      facultyYear: String(req.body.facultyYear || ""),
      masterYear: String(req.body.masterYear || ""),
      phdYear: String(req.body.phdYear || ""),
      subject: String(req.body.subject || ""),
      profile: String(req.body.profile || ""),
      topic: String(req.body.topic || ""),
    };

    const n = Math.max(1, Math.min(30, numberOfQuestions || 10));

    // best-effort text from PDF
    const decoded = tryDecodePdfToText(f.buffer);

    // dacă PDF nu se decodează ok, tot generăm din meta (dar păstrează tema)
    const sourceText = decoded
      ? `[PDF CONTENT]\n${decoded}`
      : `[PDF CONTENT]\n(Conținutul PDF nu a putut fi extras direct. Folosește contextul: materie/subiect/nivel.)`;

    const questions = await generateQuestionsFromText({
      sourceText,
      meta,
      previousQuestions: [],
      n,
    });

    const quiz_id = await insertQuizAndQuestions({
      user_id,
      language,
      source_type: "pdf",
      source_meta: { filename: f.originalname, size: f.size },
      settings: { difficulty, numberOfQuestions: n, questionType: meta.questionType, meta },
      source_text: sourceText, // IMPORTANT: salvat pt regen fără reupload
      questions,
      title: makeTitleFromMeta(meta, "pdf"),
    });

    res.json({ ok: true, quiz_id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post(`${API_PREFIX}/quiz/images`, upload.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "images[] is required" });

    const user_id = String(req.body.user_id || "").trim();
    const language = pickLanguageCode(req.body.language || "ro");
    const difficulty = String(req.body.difficulty || "medium");
    const numberOfQuestions = Number(req.body.numberOfQuestions || 10);

    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const meta = {
      user_id,
      language,
      difficulty,
      numberOfQuestions,
      questionType: String(req.body.questionType || "mcq3"),
      level: String(req.body.level || ""),
      institution: String(req.body.institution || ""),
      classYear: String(req.body.classYear || ""),
      facultyYear: String(req.body.facultyYear || ""),
      masterYear: String(req.body.masterYear || ""),
      phdYear: String(req.body.phdYear || ""),
      subject: String(req.body.subject || ""),
      profile: String(req.body.profile || ""),
      topic: String(req.body.topic || ""),
    };

    const n = Math.max(1, Math.min(30, numberOfQuestions || 10));

    // vision -> text
    const extracted = await extractTextFromImages(files, language);
    const sourceText = extracted
      ? `[IMAGES TEXT]\n${extracted.slice(0, 18000)}`
      : `[IMAGES TEXT]\n(Nu s-a putut extrage text. Folosește contextul.)`;

    const questions = await generateQuestionsFromText({
      sourceText,
      meta,
      previousQuestions: [],
      n,
    });

    const quiz_id = await insertQuizAndQuestions({
      user_id,
      language,
      source_type: "images",
      source_meta: { count: files.length },
      settings: { difficulty, numberOfQuestions: n, questionType: meta.questionType, meta },
      source_text: sourceText, // pt regen fără reupload
      questions,
      title: makeTitleFromMeta(meta, "poze"),
    });

    res.json({ ok: true, quiz_id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Regen: quiz nou pe aceeași temă (fără reupload) folosind source_text + meta
app.post(`${API_PREFIX}/quiz/regen`, async (req, res) => {
  try {
    const quiz_id = String(req.body.quiz_id || "").trim();
    const user_id = String(req.body.user_id || "").trim(); // optional, dar util

    if (!quiz_id) return res.status(400).json({ error: "quiz_id is required" });

    const { quiz, questions: oldQs } = await getQuizWithQuestions(quiz_id);

    // dacă vrei să limitezi regen doar pentru același user:
    if (user_id && quiz.user_id && user_id !== quiz.user_id) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const meta = {
      ...(quiz.settings?.meta || {}),
      language: pickLanguageCode(quiz.language || "ro"),
      difficulty: String(quiz.settings?.difficulty || "medium"),
      numberOfQuestions: Number(quiz.settings?.numberOfQuestions || 10),
      subject: quiz.settings?.meta?.subject || "",
      profile: quiz.settings?.meta?.profile || "",
      topic: quiz.settings?.meta?.topic || "",
      level: quiz.settings?.meta?.level || "",
      institution: quiz.settings?.meta?.institution || "",
      classYear: quiz.settings?.meta?.classYear || "",
      facultyYear: quiz.settings?.meta?.facultyYear || "",
      masterYear: quiz.settings?.meta?.masterYear || "",
      phdYear: quiz.settings?.meta?.phdYear || "",
      user_id: quiz.user_id,
    };

    const n = Math.max(1, Math.min(30, meta.numberOfQuestions || 10));
    const sourceText = String(quiz.source_text || "").trim();

    if (!sourceText) {
      return res.status(400).json({
        error:
          "Quiz-ul vechi nu are source_text salvat. Rulează SQL-ul (coloana source_text) și regenerează un quiz nou, apoi merge regen.",
      });
    }

    const newQuestions = await generateQuestionsFromText({
      sourceText,
      meta,
      previousQuestions: oldQs.map((q) => ({ question: q.question })),
      n,
    });

    const newQuizId = await insertQuizAndQuestions({
      user_id: quiz.user_id,
      language: meta.language,
      source_type: quiz.source_type || "topic",
      source_meta: { ...(quiz.source_meta || {}), regen_from: quiz_id },
      settings: quiz.settings || {},
      source_text: sourceText,
      questions: newQuestions,
      title: (quiz.title || "Quiz") + " (nou)",
    });

    res.json({ ok: true, quiz_id: newQuizId });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- Start ----
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`SmartQuiz API running on port ${port}`);
});
