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
app.use(express.json({ limit: "3mb" }));

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

function normalizeDifficulty(v) {
  const s = String(v || "").toLowerCase().trim();
  if (["easy", "usor", "ușor"].includes(s)) return "easy";
  if (["hard", "greu"].includes(s)) return "hard";
  return "medium";
}

// ------------------- SUPABASE -------------------
needEnv("SUPABASE_URL");
needEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Guest user id helper (nu e autentificare, doar un id simplu)
function normalizeUserId(v) {
  const s = String(v || "").trim();
  return s || ("ro_guest_" + Math.random().toString(36).slice(2, 10));
}

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
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${rawBody.slice(0, 1200)}`);

  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`OpenAI returned non-JSON body: ${rawBody.slice(0, 1200)}`); }

  const outText = extractAnyTextFromResponsesApi(data);
  if (!outText) throw new Error("OpenAI response had no extractable text (output_text/content empty).");
  return outText;
}

async function generateQuiz({ language, sourceText, options }) {
  const numberOfQuestions = safeNumber(options?.numberOfQuestions, 10);
  const difficulty = normalizeDifficulty(options?.difficulty || "medium");

  const MAX_SOURCE_CHARS = 18000;
  const trimmedSource =
    (sourceText || "").length > MAX_SOURCE_CHARS
      ? (sourceText || "").slice(0, MAX_SOURCE_CHARS) + "\n\n[NOTE: Source was truncated.]"
      : (sourceText || "");

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

  const out1 = await openaiCall({ input, schema });
  try {
    return JSON.parse(out1);
  } catch {
    const repairInput = [
      { role: "system", content: "Return ONLY valid JSON matching the schema. No extra text." },
      { role: "user", content: `Fix into valid JSON only:\n\n${out1}` },
    ];
    const out2 = await openaiCall({ input: repairInput, schema });
    return JSON.parse(out2);
  }
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
    // IMPORTANT: în DB la tine există "position" (nu idx)
    position: idx,
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

function msToNice(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return { m, s: r };
}

// ------------------- UPLOAD -------------------
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const uploadImages = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10 } });

// ------------------- ROUTES -------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// LIST quizzes for a user
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

// GET one quiz + questions (folosit de pagina ta)
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
      .select("id,type,question,choices,answer,explanation,position")
      .eq("quiz_id", id)
      .order("position", { ascending: true });

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

// ------------------- ATTEMPTS (TIMP PE TOT QUIZ-UL) -------------------

// Start attempt
app.post("/api/attempts/start", async (req, res) => {
  try {
    const quiz_id = String(req.body.quiz_id || "").trim();
    const user_id = normalizeUserId(req.body.user_id);

    if (!quiz_id) return res.status(400).json({ error: "Missing quiz_id" });

    const { count, error: cErr } = await supabase
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("quiz_id", quiz_id);

    if (cErr) throw new Error(cErr.message);
    const total = Number(count || 0);

    const { data: attempt, error } = await supabase
      .from("attempts")
      .insert([{ quiz_id, user_id, score: 0, total, started_at: new Date().toISOString(), finished_at: null }])
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    res.json({ attempt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Answer one question
app.post("/api/attempts/answer", async (req, res) => {
  try {
    const attempt_id = String(req.body.attempt_id || "").trim();
    const question_id = String(req.body.question_id || "").trim();
    const user_answer = String(req.body.user_answer ?? "").trim();

    if (!attempt_id) return res.status(400).json({ error: "Missing attempt_id" });
    if (!question_id) return res.status(400).json({ error: "Missing question_id" });

    // get correct answer
    const { data: q, error: qErr } = await supabase
      .from("questions")
      .select("id,answer")
      .eq("id", question_id)
      .single();

    if (qErr) throw new Error(qErr.message);

    const is_correct = (user_answer || "") === (q.answer || "");

    // upsert-ish: dacă user răspunde de 2 ori la aceeași întrebare, o considerăm ultima
    // (simplu: ștergem răspunsul anterior și inserăm din nou)
    await supabase
      .from("attempt_answers")
      .delete()
      .eq("attempt_id", attempt_id)
      .eq("question_id", question_id);

    const { data: row, error } = await supabase
      .from("attempt_answers")
      .insert([{
        attempt_id,
        question_id,
        user_answer,
        is_correct,
        answered_at: new Date().toISOString(),
        selected: true
      }])
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    res.json({ answer: row, is_correct });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Finish attempt (CALCULEAZĂ SCOR + DURATION_SEC)
app.post("/api/attempts/finish", async (req, res) => {
  try {
    const attempt_id = String(req.body.attempt_id || "").trim();
    if (!attempt_id) return res.status(400).json({ error: "Missing attempt_id" });

    // load attempt
    const { data: attempt, error: aErr } = await supabase
      .from("attempts")
      .select("*")
      .eq("id", attempt_id)
      .single();

    if (aErr) throw new Error(aErr.message);

    // calc score
    const { data: answers, error: ansErr } = await supabase
      .from("attempt_answers")
      .select("is_correct")
      .eq("attempt_id", attempt_id);

    if (ansErr) throw new Error(ansErr.message);

    const score = (answers || []).filter(x => x.is_correct).length;

    const finished_at = new Date().toISOString();

    // duration in seconds
    const startedMs = attempt.started_at ? new Date(attempt.started_at).getTime() : Date.now();
    const finishedMs = new Date(finished_at).getTime();
    const duration_sec = Math.max(0, Math.round((finishedMs - startedMs) / 1000));

    const { data: updated, error: upErr } = await supabase
      .from("attempts")
      .update({ score, finished_at })
      .eq("id", attempt_id)
      .select("*")
      .single();

    if (upErr) throw new Error(upErr.message);

    res.json({ attempt: updated, duration_sec });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Stats pentru UI: încercări, best, ultimul (score + time)
app.get("/api/attempts/stats", async (req, res) => {
  try {
    const quiz_id = String(req.query.quiz_id || "").trim();
    const user_id = String(req.query.user_id || "").trim();
    if (!quiz_id) return res.status(400).json({ error: "Missing quiz_id" });
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data: rows, error } = await supabase
      .from("attempts")
      .select("id,score,total,started_at,finished_at")
      .eq("quiz_id", quiz_id)
      .eq("user_id", user_id)
      .order("started_at", { ascending: false })
      .limit(200);

    if (error) throw new Error(error.message);

    const attempts = rows || [];
    const count = attempts.length;

    const withDur = attempts
      .filter(a => a.finished_at && a.started_at)
      .map(a => {
        const d = Math.max(0, Math.round((new Date(a.finished_at).getTime() - new Date(a.started_at).getTime()) / 1000));
        return { ...a, duration_sec: d };
      });

    let best = null;
    for (const a of withDur) {
      if (!best) best = a;
      else {
        // best = scor mai mare, iar la egal scor = timp mai mic
        if (a.score > best.score) best = a;
        else if (a.score === best.score && a.duration_sec < best.duration_sec) best = a;
      }
    }

    const last = withDur[0] || null;

    res.json({
      count,
      best: best ? {
        score: best.score,
        total: best.total,
        duration_sec: best.duration_sec,
        finished_at: best.finished_at
      } : null,
      last: last ? {
        score: last.score,
        total: last.total,
        duration_sec: last.duration_sec,
        finished_at: last.finished_at
      } : null
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
