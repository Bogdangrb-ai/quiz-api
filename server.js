/**
 * SmartQuiz API — server.js (CommonJS)
 * - Express API
 * - Supabase (service role)
 * - OpenAI (quiz generation "max quality")
 * - PDF upload -> extract text -> generate quiz
 *
 * Env required:
 *   OPENAI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   OPENAI_MODEL (default: gpt-4o-mini)
 *   ALLOWED_ORIGIN (default: *)
 *   PORT (default: 10000)
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // rapid + bun
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// ---------- sanity logs (fără să expună cheia) ----------
console.log("✅ Booting SmartQuiz API...");
console.log("OpenAI key present:", !!OPENAI_API_KEY);
console.log("Using OpenAI model:", OPENAI_MODEL);
console.log("Supabase URL present:", !!SUPABASE_URL);
console.log("Supabase SRK present:", !!SUPABASE_SERVICE_ROLE_KEY);

// ---------- clients ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- middleware ----------
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    credentials: false,
  })
);
app.use(express.json({ limit: "2mb" }));

// ---------- multer ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- helpers ----------
function nowISO() {
  return new Date().toISOString();
}

function pickLangLabel(lang) {
  const map = { ro: "Română", en: "English", fr: "Français", de: "Deutsch", es: "Español", it: "Italiano" };
  return map[lang] || "Română";
}

function normalizeDifficulty(diff) {
  const d = String(diff || "").toLowerCase();
  if (["easy", "usor", "ușor"].includes(d)) return "easy";
  if (["hard", "greu"].includes(d)) return "hard";
  return "medium";
}

function clampQuestions(n) {
  const x = Number(n || 10);
  if (!Number.isFinite(x)) return 10;
  return Math.max(1, Math.min(10, Math.round(x))); // momentan max 10
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stripHuge(text, maxChars = 35000) {
  const t = String(text || "");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n\n[...trunchiat pentru limită...]";
}

// prompt de “calitate mare”
function buildPrompt({ language, difficulty, numberOfQuestions, subject, profile, topic, level, institution, classYear, facultyYear, masterYear, phdYear, sourceText }) {
  const langLabel = pickLangLabel(language);
  const diff = normalizeDifficulty(difficulty);

  const contextLines = [];
  if (level) contextLines.push(`Nivel: ${level}`);
  if (institution) contextLines.push(`Instituție: ${institution}`);
  if (classYear) contextLines.push(`Clasă: ${classYear}`);
  if (facultyYear) contextLines.push(`An facultate: ${facultyYear}`);
  if (masterYear) contextLines.push(`Master: anul ${masterYear}`);
  if (phdYear) contextLines.push(`Doctorat: anul ${phdYear}`);
  if (subject) contextLines.push(`Materie: ${subject}`);
  if (profile) contextLines.push(`Profil: ${profile}`);
  if (topic) contextLines.push(`Subiect: ${topic}`);

  const context = contextLines.length ? contextLines.join("\n") : "N/A";

  const styleByDiff = {
    easy: "întrebări de bază + recunoaștere concepte; fără capcane grele",
    medium: "nivel de test/examen: aplicare + diferențe fine între termeni; distractori plauzibili",
    hard: "nivel avansat: nuanțe, excepții, condiții; distractori foarte plauzibili; evită întrebări triviale",
  }[diff];

  const rules = `
Cerințe obligatorii:
- Limba: ${langLabel} (100% în această limbă, inclusiv explicații).
- Număr întrebări: exact ${numberOfQuestions}.
- Tip: grilă cu 3 variante (choices: exact 3).
- EXACT o singură variantă corectă.
- Distractorii trebuie să fie plauzibili și specifici (nu evident greșiți).
- Întrebările să fie cât mai “de examen”, nu definiții triviale.
- Dacă există text sursă, bazează-te STRICT pe el. NU inventa.
- Fiecare întrebare să aibă o explicație utilă (2-5 propoziții) care:
  1) justifică răspunsul corect
  2) explică de ce celelalte sunt greșite (pe scurt)
- Output strict JSON.

Format de output (JSON):
{
  "title": "string",
  "language": "${language}",
  "questions": [
    {
      "question": "string",
      "choices": ["A", "B", "C"],
      "answer": "exact una dintre choices",
      "explanation": "string"
    }
  ]
}
`.trim();

  const hasSource = !!(sourceText && String(sourceText).trim());
  const sourceBlock = hasSource
    ? `TEXT SURSA (folosește STRICT acest text, nu inventa):\n"""${stripHuge(sourceText)}"""\n`
    : "";

  const topicBlock = !hasSource
    ? `NU există text sursă. Creează quiz-ul folosind contextul de mai jos, fără halucinații inutile.\n`
    : "";

  const prompt = `
Ești un profesor exigent care creează quiz-uri de calitate (stil examen).
Context (dacă e cazul):
${context}

Nivel dorit: ${styleByDiff}

${topicBlock}
${sourceBlock}

${rules}
`.trim();

  return prompt;
}

// apel OpenAI cu retry dacă JSON-ul nu e ok sau nu respectă
async function generateQuizWithOpenAI(meta) {
  if (!OPENAI_API_KEY) throw new Error("Lipsește OPENAI_API_KEY în environment.");

  const prompt = buildPrompt(meta);

  const makeCall = async (attempt) => {
    console.log(`[OpenAI] calling model=${OPENAI_MODEL} attempt=${attempt}`);
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: attempt === 1 ? 0.45 : 0.25, // mai controlat la retry
      messages: [
        { role: "system", content: "Returnează DOAR JSON valid. Fără markdown, fără text extra." },
        { role: "user", content: prompt },
      ],
      // multe modele suportă asta; dacă modelul tău nu suportă, scoate linia:
      response_format: { type: "json_object" },
    });

    const text = res?.choices?.[0]?.message?.content || "";
    const json = safeJsonParse(text);
    if (!json || !json.questions || !Array.isArray(json.questions)) {
      throw new Error("OpenAI nu a returnat JSON valid cu questions[].");
    }

    // validare strictă
    const qs = json.questions;
    const n = meta.numberOfQuestions;

    if (qs.length !== n) throw new Error(`OpenAI a returnat ${qs.length} întrebări, dar cerute ${n}.`);

    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q.question || !Array.isArray(q.choices) || q.choices.length !== 3 || !q.answer) {
        throw new Error(`Întrebarea ${i + 1} are structură invalidă.`);
      }
      if (!q.choices.includes(q.answer)) {
        throw new Error(`Întrebarea ${i + 1} are answer care nu e în choices.`);
      }
      // unicitate choices
      const set = new Set(q.choices.map(String));
      if (set.size !== 3) throw new Error(`Întrebarea ${i + 1} are choices duplicate.`);
    }

    return {
      title: json.title || meta.subject || meta.topic || "Quiz",
      language: meta.language,
      questions: qs.map((q) => ({
        question: String(q.question).trim(),
        choices: q.choices.map((c) => String(c).trim()),
        answer: String(q.answer).trim(),
        explanation: String(q.explanation || "").trim(),
      })),
    };
  };

  try {
    return await makeCall(1);
  } catch (e1) {
    console.log("[OpenAI] first attempt failed:", e1.message || e1);
    // retry cu “mai strict”
    const stricter = {
      ...meta,
      // forțăm și mai mult respectarea limbii
      subject: meta.subject,
      topic: meta.topic,
    };
    return await makeCall(2);
  }
}

// ---------- DB helpers ----------
async function insertQuizAndQuestions({ user_id, language, source_type, source_meta, settings, title, source_text, questions }) {
  // 1) insert quiz
  const quizRow = {
    user_id,
    title,
    language,
    source_type,
    source_meta: source_meta || {},
    settings: settings || {},
    source_text: source_text || null,
    created_at: nowISO(),
  };

  const { data: quizIns, error: quizErr } = await supabase
    .from("quizzes")
    .insert(quizRow)
    .select("*")
    .single();

  if (quizErr) throw new Error(`DB quizzes insert error: ${quizErr.message}`);

  const quiz_id = quizIns.id;

  // 2) insert questions (idx NOT NULL)
  const qRows = questions.map((q, i) => ({
    quiz_id,
    idx: i + 1,
    question: q.question,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation || null,
  }));

  const { error: qErr } = await supabase.from("questions").insert(qRows);
  if (qErr) throw new Error(`DB questions insert error: ${qErr.message}`);

  return quiz_id;
}

// ---------- routes ----------

// health
app.get("/", (req, res) => res.json({ ok: true, service: "smartquiz-api", time: nowISO() }));

// list quizzes by user_id
app.get("/api/quizzes", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data, error } = await supabase
      .from("quizzes")
      .select("id,title,language,source_type,source_meta,settings,created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    res.json({ quizzes: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// get quiz + questions
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
      .select("id,idx,question,choices,answer,explanation")
      .eq("quiz_id", id)
      .order("idx", { ascending: true });

    if (qsErr) throw new Error(qsErr.message);

    res.json({ quiz, questions: questions || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// TOPIC: generate from subject/topic (no files)
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const body = req.body || {};
    const user_id = String(body.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const language = String(body.language || "ro");
    const difficulty = normalizeDifficulty(body.difficulty || "medium");
    const numberOfQuestions = clampQuestions(body.numberOfQuestions || 10);

    const meta = {
      user_id,
      language,
      difficulty,
      numberOfQuestions,
      questionType: "mcq3",

      level: String(body.level || ""),
      institution: String(body.institution || ""),
      classYear: String(body.classYear || ""),
      facultyYear: String(body.facultyYear || ""),
      masterYear: String(body.masterYear || ""),
      phdYear: String(body.phdYear || ""),

      subject: String(body.subject || "").trim(),
      profile: String(body.profile || "").trim(),
      topic: String(body.topic || "").trim(),

      sourceText: "", // topic mode
    };

    if (!meta.subject) return res.status(400).json({ error: "Missing subject (Materie)" });

    const aiQuiz = await generateQuizWithOpenAI(meta);

    const quiz_id = await insertQuizAndQuestions({
      user_id,
      language,
      source_type: "topic",
      source_meta: { subject: meta.subject, profile: meta.profile, topic: meta.topic },
      settings: {
        difficulty,
        numberOfQuestions,
        questionType: "mcq3",
        level: meta.level,
        institution: meta.institution,
        classYear: meta.classYear,
        facultyYear: meta.facultyYear,
        masterYear: meta.masterYear,
        phdYear: meta.phdYear,
        subject: meta.subject,
        profile: meta.profile,
        topic: meta.topic,
      },
      title: aiQuiz.title,
      source_text: null,
      questions: aiQuiz.questions,
    });

    res.json({ quiz_id });
  } catch (e) {
    console.log("[/api/quiz/topic] error:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// PDF: upload -> extract -> generate
app.post("/api/quiz/pdf", upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: "Missing file" });

    const user_id = String(req.body.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const language = String(req.body.language || "ro");
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");
    const numberOfQuestions = clampQuestions(req.body.numberOfQuestions || 10);

    // meta optional
    const meta = {
      user_id,
      language,
      difficulty,
      numberOfQuestions,
      questionType: "mcq3",

      level: String(req.body.level || ""),
      institution: String(req.body.institution || ""),
      classYear: String(req.body.classYear || ""),
      facultyYear: String(req.body.facultyYear || ""),
      masterYear: String(req.body.masterYear || ""),
      phdYear: String(req.body.phdYear || ""),

      subject: String(req.body.subject || "").trim(),
      profile: String(req.body.profile || "").trim(),
      topic: String(req.body.topic || "").trim(),

      sourceText: "",
    };

    // extract pdf text
    console.log("[PDF] parsing:", f.originalname, f.size);
    const parsed = await pdfParse(f.buffer);
    const text = (parsed?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Nu am putut extrage text din PDF (poate e scanat)." });

    meta.sourceText = text;

    // IMPORTANT: dacă PDF e în română dar user a ales ro, promptul forțează româna.
    // Dacă vrei automat detect, se poate, dar acum ținem STRICT de alegerea userului.

    const aiQuiz = await generateQuizWithOpenAI(meta);

    const quiz_id = await insertQuizAndQuestions({
      user_id,
      language,
      source_type: "pdf",
      source_meta: { filename: f.originalname, size: f.size },
      settings: {
        difficulty,
        numberOfQuestions,
        questionType: "mcq3",
        level: meta.level,
        institution: meta.institution,
        classYear: meta.classYear,
        facultyYear: meta.facultyYear,
        masterYear: meta.masterYear,
        phdYear: meta.phdYear,
        subject: meta.subject,
        profile: meta.profile,
        topic: meta.topic,
      },
      title: aiQuiz.title,
      // salvăm textul sursă -> regen fără reupload e posibil (prin endpoint separat)
      source_text: text,
      questions: aiQuiz.questions,
    });

    res.json({ quiz_id });
  } catch (e) {
    console.log("[/api/quiz/pdf] error:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// (OPTIONAL) regen “same theme” fără reupload, folosind source_text din DB
app.post("/api/quiz/regen/:quiz_id", async (req, res) => {
  try {
    const quiz_id = req.params.quiz_id;

    const { data: quiz, error: qErr } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", quiz_id)
      .single();

    if (qErr) throw new Error(qErr.message);
    if (!quiz) throw new Error("Quiz not found");

    const user_id = quiz.user_id;
    const settings = quiz.settings || {};
    const sourceText = quiz.source_text || "";

    // dacă nu avem source_text și era PDF, nu putem fără reupload
    if (quiz.source_type === "pdf" && !sourceText) {
      return res.status(400).json({ error: "Quiz-ul nu are source_text salvat. Reîncarcă PDF." });
    }

    const meta = {
      user_id,
      language: quiz.language || "ro",
      difficulty: settings.difficulty || "medium",
      numberOfQuestions: clampQuestions(settings.numberOfQuestions || 10),
      questionType: "mcq3",

      level: settings.level || "",
      institution: settings.institution || "",
      classYear: settings.classYear || "",
      facultyYear: settings.facultyYear || "",
      masterYear: settings.masterYear || "",
      phdYear: settings.phdYear || "",

      subject: settings.subject || (quiz.source_meta?.subject || ""),
      profile: settings.profile || (quiz.source_meta?.profile || ""),
      topic: settings.topic || (quiz.source_meta?.topic || ""),

      sourceText: sourceText || "",
    };

    const aiQuiz = await generateQuizWithOpenAI(meta);

    const newQuizId = await insertQuizAndQuestions({
      user_id,
      language: meta.language,
      source_type: quiz.source_type || "topic",
      source_meta: quiz.source_meta || {},
      settings: settings,
      title: aiQuiz.title,
      source_text: sourceText || null,
      questions: aiQuiz.questions,
    });

    res.json({ quiz_id: newQuizId });
  } catch (e) {
    console.log("[/api/quiz/regen] error:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SmartQuiz API running on ${PORT}`);
});
