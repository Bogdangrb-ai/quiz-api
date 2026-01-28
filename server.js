// server.js (CAP-COADĂ, gata de lipit)

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

function normalizeLanguage(lang) {
  if (!lang) return "en";
  const v = String(lang).trim().toLowerCase();

  // Acceptă mai multe forme
  if (["ro", "romana", "română", "romanian", "rom"].includes(v)) return "ro";
  if (["en", "english"].includes(v)) return "en";
  if (["fr", "french", "français"].includes(v)) return "fr";
  if (["de", "german", "deutsch"].includes(v)) return "de";
  if (["es", "spanish", "español"].includes(v)) return "es";
  if (["it", "italian", "italiano"].includes(v)) return "it";

  // fallback: dacă vine deja "ro", "en" etc
  if (v.length <= 3) return v;
  return "en";
}

// detectare simplă: dacă output-ul pare engleză, facem retry (pentru RO)
function looksEnglish(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const hits = [
    "the ",
    " and ",
    " is ",
    " are ",
    "which ",
    "what ",
    "choose ",
    "correct ",
    "question ",
    "answer ",
    "explanation ",
    "true",
    "false",
  ].reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
  return hits >= 4;
}

// Guest user id helper (nu e autentificare, doar un id simplu)
function normalizeUserId(v) {
  const s = String(v || "").trim();
  return s || "ro_guest_" + Math.random().toString(36).slice(2, 10);
}

// ------------------- SUPABASE -------------------
needEnv("SUPABASE_URL");
needEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ------------------- OPENAI (Responses API) -------------------
function extractAnyTextFromResponsesApi(data) {
  if (!data) return "";

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

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
  const numberOfQuestions = safeNumber(options?.numberOfQuestions, 10);
  const difficulty = normalizeDifficulty(options?.difficulty || "medium");

  const MAX_SOURCE_CHARS = 18000;
  const trimmedSource =
    (sourceText || "").length > MAX_SOURCE_CHARS
      ? (sourceText || "").slice(0, MAX_SOURCE_CHARS) + "\n\n[NOTE: Source was truncated.]"
      : sourceText || "";

  // STRICT SCHEMA (MCQ ONLY)
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
            choices: { type: "array", items: { type: "string" }, minItems: 2 },
            answer: { type: "string" },
            explanation: { type: "string" },
          },
        },
      },
    },
  };

  const langLine =
    language === "ro"
      ? "You MUST write EVERYTHING in Romanian (Română). Do NOT use English."
      : `You MUST write EVERYTHING in language code: ${language}.`;

  const systemPrompt =
    "Return ONLY valid JSON matching the provided JSON schema. " +
    "No markdown. No extra text. " +
    langLine +
    " Keep explanations short (1-2 sentences).";

  const userPrompt = `
LANGUAGE_CODE: ${language}
NUMBER_OF_QUESTIONS: ${numberOfQuestions}
DIFFICULTY: ${difficulty}

Generate multiple-choice questions ONLY.
- Provide exactly 4 choices for each question.
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

  // 1) prima încercare
  let out = await openaiCall({ input, schema });

  // dacă e RO și pare engleză -> retry o dată, super strict
  if (language === "ro" && looksEnglish(out)) {
    const retryInput = [
      {
        role: "system",
        content: "Return ONLY valid JSON matching the schema. ABSOLUTELY EVERYTHING must be Romanian. No English.",
      },
      {
        role: "user",
        content: "Rewrite the quiz output strictly in Romanian, preserving meaning, still valid JSON:\n\n" + out,
      },
    ];
    out = await openaiCall({ input: retryInput, schema });
  }

  // parse + repair
  try {
    return JSON.parse(out);
  } catch {
    const repairInput = [
      { role: "system", content: "Return ONLY valid JSON matching the schema. No extra text." },
      { role: "user", content: `Fix into valid JSON only:\n\n${out}` },
    ];
    const out2 = await openaiCall({ input: repairInput, schema });
    return JSON.parse(out2);
  }
}

// ------------------- DB SAVE HELPERS -------------------
// IMPORTANT: în tabela questions tu ai coloana `idx` (nu `position`).
async function saveQuizToDb({ user_id, title, language, source_type, source_meta, settings, questions }) {
  // 1) insert quiz
  const { data: quizRow, error: qErr } = await supabase
    .from("quizzes")
    .insert([
      {
        user_id,
        title,
        language,
        source_type,
        source_meta: source_meta || {},
        settings: settings || {},
      },
    ])
    .select("id")
    .single();

  if (qErr) throw new Error(qErr.message);

  const quiz_id = quizRow.id;

  // 2) insert questions
  const rows = (questions || []).map((q, idx) => ({
    quiz_id,
    idx: idx, // 0..n-1
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

// LIST quizzes for a user (+ summary attempts: count/best/last)
app.get("/api/quizzes", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data: quizzes, error } = await supabase
      .from("quizzes")
      .select("id,title,language,source_type,source_meta,settings,created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);

    const list = quizzes || [];
    // adăugăm agregate simple din attempts
    const enriched = [];
    for (const q of list) {
      const quiz_id = q.id;

      const { data: aCount, error: e1 } = await supabase
        .from("attempts")
        .select("id", { count: "exact", head: true })
        .eq("quiz_id", quiz_id)
        .eq("user_id", user_id);

      if (e1) throw new Error(e1.message);

      const { data: lastAttempt, error: e2 } = await supabase
        .from("attempts")
        .select("score,total,finished_at")
        .eq("quiz_id", quiz_id)
        .eq("user_id", user_id)
        .not("finished_at", "is", null)
        .order("finished_at", { ascending: false })
        .limit(1);

      if (e2) throw new Error(e2.message);

      const { data: bestAttempt, error: e3 } = await supabase
        .from("attempts")
        .select("score,total")
        .eq("quiz_id", quiz_id)
        .eq("user_id", user_id)
        .not("finished_at", "is", null)
        .order("score", { ascending: false })
        .limit(1);

      if (e3) throw new Error(e3.message);

      const attempts_count = aCount?.length === 0 ? 0 : (aCount?.count ?? 0); // compat
      const last = (lastAttempt && lastAttempt[0]) || null;
      const best = (bestAttempt && bestAttempt[0]) || null;

      enriched.push({
        ...q,
        attempts_count: attempts_count || 0,
        best_score: best ? best.score : null,
        best_total: best ? best.total : null,
        last_score: last ? last.score : null,
        last_total: last ? last.total : null,
        last_finished_at: last ? last.finished_at : null,
      });
    }

    res.json({ quizzes: enriched });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET one quiz + questions (ordered by idx) — folosit de pagina “quiz-urile mele”
app.get("/api/quizzes/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const { data: quiz, error: qErr } = await supabase.from("quizzes").select("*").eq("id", id).single();
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

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
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

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
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

// ------------------- ATTEMPTS (pentru scor oficial) -------------------

// start attempt
app.post("/api/attempts/start", async (req, res) => {
  try {
    const quiz_id = String(req.body.quiz_id || "").trim();
    const user_id = normalizeUserId(req.body.user_id);

    if (!quiz_id) return res.status(400).json({ error: "Missing quiz_id" });

    // total = nr întrebări
    const { data: qs, error: eQs } = await supabase
      .from("questions")
      .select("id", { count: "exact" })
      .eq("quiz_id", quiz_id);

    if (eQs) throw new Error(eQs.message);
    const total = (qs && qs.length) ? qs.length : 0;

    const { data: attempt, error: eA } = await supabase
      .from("attempts")
      .insert([{ quiz_id, user_id, score: 0, total }])
      .select("*")
      .single();

    if (eA) throw new Error(eA.message);

    res.json({ attempt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// answer a question
app.post("/api/attempts/answer", async (req, res) => {
  try {
    const attempt_id = String(req.body.attempt_id || "").trim();
    const question_id = String(req.body.question_id || "").trim();
    const user_answer = String(req.body.user_answer ?? "");

    if (!attempt_id) return res.status(400).json({ error: "Missing attempt_id" });
    if (!question_id) return res.status(400).json({ error: "Missing question_id" });

    // luăm răspunsul corect
    const { data: q, error: eQ } = await supabase
      .from("questions")
      .select("id,answer")
      .eq("id", question_id)
      .single();

    if (eQ) throw new Error(eQ.message);

    const is_correct = user_answer === (q?.answer ?? "");

    // dacă există deja un răspuns la aceeași întrebare, îl înlocuim (simplu)
    const { data: existing, error: eEx } = await supabase
      .from("attempt_answers")
      .select("id")
      .eq("attempt_id", attempt_id)
      .eq("question_id", question_id)
      .limit(1);

    if (eEx) throw new Error(eEx.message);

    if (existing && existing[0]) {
      const { error: eUp } = await supabase
        .from("attempt_answers")
        .update({ user_answer, is_correct, answered_at: new Date().toISOString() })
        .eq("id", existing[0].id);

      if (eUp) throw new Error(eUp.message);
    } else {
      const { error: eIns } = await supabase.from("attempt_answers").insert([
        {
          attempt_id,
          question_id,
          user_answer,
          is_correct,
        },
      ]);
      if (eIns) throw new Error(eIns.message);
    }

    res.json({ ok: true, is_correct });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// finish attempt (calculează scor oficial)
app.post("/api/attempts/finish", async (req, res) => {
  try {
    const attempt_id = String(req.body.attempt_id || "").trim();
    if (!attempt_id) return res.status(400).json({ error: "Missing attempt_id" });

    // attempt
    const { data: attempt, error: eA } = await supabase.from("attempts").select("*").eq("id", attempt_id).single();
    if (eA) throw new Error(eA.message);

    // score = nr răspunsuri corecte
    const { data: answers, error: eAns } = await supabase
      .from("attempt_answers")
      .select("is_correct")
      .eq("attempt_id", attempt_id);

    if (eAns) throw new Error(eAns.message);

    const score = (answers || []).reduce((acc, a) => acc + (a.is_correct ? 1 : 0), 0);

    const finished_at = new Date().toISOString();

    const { data: updated, error: eUp } = await supabase
      .from("attempts")
      .update({ score, finished_at })
      .eq("id", attempt_id)
      .select("*")
      .single();

    if (eUp) throw new Error(eUp.message);

    res.json({ attempt: updated });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// (optional) summary pt un quiz
app.get("/api/attempts/summary", async (req, res) => {
  try {
    const quiz_id = String(req.query.quiz_id || "").trim();
    const user_id = String(req.query.user_id || "").trim();
    if (!quiz_id) return res.status(400).json({ error: "Missing quiz_id" });
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data: all, error } = await supabase
      .from("attempts")
      .select("score,total,finished_at,started_at,id")
      .eq("quiz_id", quiz_id)
      .eq("user_id", user_id)
      .order("started_at", { ascending: false });

    if (error) throw new Error(error.message);

    const finished = (all || []).filter((a) => a.finished_at);
    const attempts_count = (all || []).length;

    let best = null;
    for (const a of finished) {
      if (!best || (a.score ?? 0) > (best.score ?? 0)) best = a;
    }
    const last = finished.length ? finished[0] : null;

    res.json({
      attempts_count,
      best_score: best ? best.score : null,
      best_total: best ? best.total : null,
      last_score: last ? last.score : null,
      last_total: last ? last.total : null,
      last_finished_at: last ? last.finished_at : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ------------------- START -------------------
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log("Quiz API running on port", port));

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log("Quiz API running on port", port));
