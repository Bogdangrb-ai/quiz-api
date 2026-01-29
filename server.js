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
  const s = String(lang || "").trim().toLowerCase();
  const allowed = new Set([
    "ro","en","fr","de","es","it","pt","nl","pl","tr","uk","ru",
    "ar","he","fa","ur","hi","zh","ja","ko"
  ]);
  if (allowed.has(s)) return s;
  return "ro";
}

function normalizeUserId(v) {
  const s = String(v || "").trim();
  return s || ("ro_guest_" + Math.random().toString(36).slice(2, 10));
}

// ------------------- SUPABASE -------------------
needEnv("SUPABASE_URL");
needEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ------------------- UPLOAD -------------------
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const uploadImages = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10 } });

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

async function openaiCall({ input, schema, temperature = 0.6, maxOutputTokens = 1500 }) {
  needEnv("OPENAI_API_KEY");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      max_output_tokens: maxOutputTokens,
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

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${raw.slice(0, 1400)}`);

  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`OpenAI returned non-JSON body: ${raw.slice(0, 1400)}`); }

  const outText = extractAnyTextFromResponsesApi(data);
  if (!outText) throw new Error("OpenAI response had no extractable text.");
  return outText;
}

// ------------------- VALIDATOR (ON-DEMAND) -------------------
function looksRomanian(text) {
  const t = String(text || "").slice(0, 700).toLowerCase();
  const enHits = [" the ", " and ", " of ", " is ", " are ", "which", "what", "when", "where", "explanation"];
  const hits = enHits.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
  return hits <= 2;
}

function validateQuizStrict({ quiz, language, numberOfQuestions }) {
  const problems = [];

  if (!quiz || typeof quiz !== "object") problems.push("Quiz is not an object.");
  if (!quiz.title || typeof quiz.title !== "string") problems.push("Missing title.");
  if (quiz.language !== language) problems.push(`language must be exactly '${language}'.`);

  const qs = quiz.questions;
  if (!Array.isArray(qs) || qs.length < 1) problems.push("questions must be a non-empty array.");

  if (Array.isArray(qs)) {
    if (numberOfQuestions && qs.length !== numberOfQuestions) {
      // nu e “fatal”, dar îl corectăm ca să respecte cerința
      problems.push(`questions length must be exactly ${numberOfQuestions}.`);
    }

    const seen = new Set();
    qs.forEach((q, i) => {
      if (!q || typeof q !== "object") return problems.push(`Question ${i} invalid object.`);
      if (q.type !== "mcq") problems.push(`Question ${i}: type must be 'mcq'.`);
      if (!q.question || typeof q.question !== "string") problems.push(`Question ${i}: missing question text.`);
      if (!Array.isArray(q.choices) || q.choices.length !== 3) problems.push(`Question ${i}: choices must be exactly 3.`);
      if (Array.isArray(q.choices)) {
        const uniq = new Set(q.choices.map(x => String(x).trim()));
        if (uniq.size !== q.choices.length) problems.push(`Question ${i}: choices must be distinct.`);
      }
      if (!q.answer || typeof q.answer !== "string") problems.push(`Question ${i}: missing answer.`);
      if (Array.isArray(q.choices) && !q.choices.includes(q.answer)) problems.push(`Question ${i}: answer must match one of the choices exactly.`);
      if (q.explanation != null && typeof q.explanation !== "string") problems.push(`Question ${i}: explanation must be a string.`);
      // duplicate question check
      const key = String(q.question || "").toLowerCase().trim().slice(0, 120);
      if (key) {
        if (seen.has(key)) problems.push(`Duplicate question detected near question ${i}.`);
        seen.add(key);
      }
    });
  }

  // limbă RO check (doar dacă ro)
  if (language === "ro") {
    const blob = JSON.stringify(quiz);
    if (!looksRomanian(blob)) problems.push("Output does not look Romanian.");
  }

  return problems;
}

// ------------------- QUIZ GENERATION -------------------
function buildSchema({ language, numberOfQuestions }) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "language", "questions"],
    properties: {
      title: { type: "string" },
      language: { type: "string", enum: [language] },
      questions: {
        type: "array",
        minItems: numberOfQuestions,
        maxItems: numberOfQuestions,
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
}

function buildMetaBlock(extraMeta) {
  if (!extraMeta) return "";
  return `
CONTEXT (use this to adapt difficulty/style, but DO NOT invent facts for PDF/Image modes):
- level: ${extraMeta.level || ""}
- classYear: ${extraMeta.classYear || ""}
- facultyYear: ${extraMeta.facultyYear || ""}
- masterYear: ${extraMeta.masterYear || ""}
- phdYear: ${extraMeta.phdYear || ""}
- institution: ${extraMeta.institution || ""}
- subject: ${extraMeta.subject || ""}
- profile: ${extraMeta.profile || ""}
- topic: ${extraMeta.topic || ""}
- variant: ${extraMeta.variant || ""}
`;
}

async function generateQuizFromSource({
  language,
  sourceText,
  options,
  extraMeta,
  allowGeneralKnowledge = false,
}) {
  const numberOfQuestions = safeNumber(options?.numberOfQuestions, 10);
  const difficulty = normalizeDifficulty(options?.difficulty || "medium");
  const variant = String(extraMeta?.variant || "").trim() || Math.random().toString(36).slice(2, 10);

  // trim input for speed
  const MAX_SOURCE_CHARS = 14000;
  const trimmedSource =
    (sourceText || "").length > MAX_SOURCE_CHARS
      ? (sourceText || "").slice(0, MAX_SOURCE_CHARS) + "\n\n[NOTE: Source was truncated.]"
      : (sourceText || "");

  const schema = buildSchema({ language, numberOfQuestions });

  const metaBlock = buildMetaBlock({ ...extraMeta, variant });

  const systemPrompt =
    "Return ONLY valid JSON that matches the provided JSON schema. " +
    "No markdown. No extra text. " +
    "CRITICAL: Write EVERYTHING strictly in the requested language. " +
    "Avoid repeating the same concept; make questions cover different key points.";

  const knowledgeRule = allowGeneralKnowledge
    ? "You MAY use general knowledge, but stay strictly within the chosen subject/topic and level."
    : "Use ONLY the source text. Do NOT invent outside facts.";

  const userPrompt = `
LANGUAGE: ${language}
DIFFICULTY: ${difficulty}
NUMBER_OF_QUESTIONS: ${numberOfQuestions}
VARIANT: ${variant}

Rules:
- Output language MUST be exactly: ${language}
- Multiple-choice ONLY: exactly 3 choices per question.
- Answer MUST match one of the choices exactly.
- Keep explanations short (1 sentence).
- Make questions diverse: definitions, conditions, exceptions, steps, examples (when possible).
- ${knowledgeRule}

${metaBlock}

SOURCE:
<<<
${trimmedSource}
>>>
`;

  const input = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // 1) generate (faster + diversity)
  const out1 = await openaiCall({ input, schema, temperature: 0.65, maxOutputTokens: 1500 });

  let quiz;
  try { quiz = JSON.parse(out1); }
  catch {
    // quick repair if JSON broken
    const repairInput = [
      { role: "system", content: "Return ONLY valid JSON matching the schema. No extra text." },
      { role: "user", content: `Fix into valid JSON only:\n\n${out1}` },
    ];
    const out2 = await openaiCall({ input: repairInput, schema, temperature: 0, maxOutputTokens: 1500 });
    quiz = JSON.parse(out2);
  }

  // 2) validate on-demand (only if needed)
  const problems = validateQuizStrict({ quiz, language, numberOfQuestions });
  if (problems.length) {
    const fixPrompt = `
You must output ONLY valid JSON that matches the schema exactly.
Fix these problems:
- ${problems.join("\n- ")}

Keep content in language: ${language}.
Keep exactly ${numberOfQuestions} questions.
Keep exactly 3 choices per question.
Ensure answer matches a choice.

Here is the previous JSON to fix:
<<<
${JSON.stringify(quiz)}
>>>
`;
    const fixInput = [
      { role: "system", content: "Return ONLY valid JSON matching the provided schema. No extra text." },
      { role: "user", content: fixPrompt },
    ];
    const outFix = await openaiCall({ input: fixInput, schema, temperature: 0, maxOutputTokens: 1500 });
    quiz = JSON.parse(outFix);
  }

  return quiz;
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
    idx,
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
      topic: req.body.topic,
      variant: req.body.variant,
    };

    const quiz = await generateQuizFromSource({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
      extraMeta,
      allowGeneralKnowledge: false,
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
      topic: req.body.topic,
      variant: req.body.variant,
    };

    const quiz = await generateQuizFromSource({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
      extraMeta,
      allowGeneralKnowledge: false,
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

// TOPIC (fără fișiere) -> generate -> save -> return
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = safeNumber(req.body.numberOfQuestions, 10);
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");
    const user_id = normalizeUserId(req.body.user_id);

    const subject = String(req.body.subject || "").trim();
    const profile = String(req.body.profile || "").trim();
    const topic = String(req.body.topic || "").trim();

    if (!subject) return res.status(400).json({ error: "Missing subject (materie)" });

    const extraMeta = {
      level: req.body.level,
      classYear: req.body.classYear,
      facultyYear: req.body.facultyYear,
      masterYear: req.body.masterYear,
      phdYear: req.body.phdYear,
      institution: req.body.institution,
      subject,
      profile,
      topic,
      variant: req.body.variant,
    };

    // “sourceText” e cererea userului (aici permitem knowledge)
    const sourceText = `
User selected:
- Subject: ${subject}
- Profile: ${profile}
- Topic: ${topic}
- Level: ${extraMeta.level || ""}
- Class/Year: ${extraMeta.classYear || extraMeta.facultyYear || ""}
Make a quiz within this scope.
`.trim();

    const quiz = await generateQuizFromSource({
      language,
      sourceText,
      options: { numberOfQuestions, difficulty },
      extraMeta,
      allowGeneralKnowledge: true,
    });

    const quiz_id = await saveQuizToDb({
      user_id,
      title: quiz.title || `${subject}${topic ? " — " + topic : ""}`,
      language,
      source_type: "topic",
      source_meta: { subject, profile, topic },
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
