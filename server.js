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
  if (!lang || typeof lang !== "string") return "ro"; // default RO (important)
  const v = lang.trim().toLowerCase();
  return v ? v : "ro";
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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

async function openaiCall({ input, schema, temperature = 0 }) {
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
  if (!outText) throw new Error("OpenAI response had no extractable text.");
  return outText;
}

async function generateQuiz({ language, sourceText, options, variationSeed }) {
  // MCQ only, 4 choices
  const numberOfQuestions = clamp(safeNumber(options?.numberOfQuestions, 10), 3, 20);
  const difficulty = normalizeDifficulty(options?.difficulty || "medium");
  const lang = normalizeLanguage(language);

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
            choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
            answer: { type: "string" },
            explanation: { type: "string" },
          },
        },
      },
    },
  };

  // IMPORTANT: For language correctness
  const systemPrompt =
    "Return ONLY valid JSON matching the provided JSON schema. " +
    "No markdown. No extra text. " +
    "All content MUST be strictly in the requested language. " +
    "Keep explanations short (1-2 sentences). " +
    "The 'answer' MUST match exactly one of the 'choices'.";

  // variationSeed => ca să fie diferit la regenerate
  const seedLine = variationSeed
    ? `VARIATION_SEED: ${variationSeed}\nMake the questions meaningfully different from previous variants, but still based ONLY on the source.\n`
    : "";

  const userPrompt = `
LANGUAGE: ${lang}
NUMBER_OF_QUESTIONS: ${numberOfQuestions}
DIFFICULTY: ${difficulty}
${seedLine}
Generate multiple-choice questions ONLY.
- Provide exactly 4 choices for each question.
- Use ONLY the source text. Do not invent outside facts.

SOURCE TEXT:
<<<
${trimmedSource}
>>>
`;

  const input = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // First try (puțin >0 la regenerate ca să varieze)
  const temp = variationSeed ? 0.35 : 0;

  const out1 = await openaiCall({ input, schema, temperature: temp });

  try {
    return JSON.parse(out1);
  } catch {
    const repairInput = [
      { role: "system", content: "Return ONLY valid JSON matching the schema. No extra text." },
      { role: "user", content: `Fix into valid JSON only:\n\n${out1}` },
    ];
    const out2 = await openaiCall({ input: repairInput, schema, temperature: 0 });
    return JSON.parse(out2);
  }
}

// ------------------- DB HELPERS -------------------
async function saveQuizToDb({
  user_id,
  title,
  language,
  source_type,
  source_meta,
  settings,
  questions,
  source_text,
  topic_payload,
}) {
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
    position: idx + 1,
    type: q.type || "mcq",
    question: q.question || "",
    choices: q.choices || [],
    answer: q.answer || "",
    explanation: q.explanation || "",
  }));

  const { error: qsErr } = await supabase.from("questions").insert(rows);
  if (qsErr) throw new Error(qsErr.message);

  // 3) insert source backup for regenerate (NEW)
  // NOTE: ai nevoie de tabela quiz_sources (SQL de mai sus)
  const { error: sErr } = await supabase.from("quiz_sources").insert([
    {
      quiz_id,
      source_text: source_text || null,
      topic_payload: topic_payload || null,
    },
  ]);
  if (sErr) {
    // nu stricăm flow-ul dacă lipsește tabela; dar pentru regenerate trebuie.
    console.warn("quiz_sources insert failed:", sErr.message);
  }

  return quiz_id;
}

async function getQuizWithSource(quiz_id) {
  const { data: quiz, error: qErr } = await supabase
    .from("quizzes")
    .select("id,user_id,title,language,source_type,source_meta,settings,created_at")
    .eq("id", quiz_id)
    .single();

  if (qErr) throw new Error(qErr.message);

  const { data: src, error: sErr } = await supabase
    .from("quiz_sources")
    .select("source_text,topic_payload")
    .eq("quiz_id", quiz_id)
    .single();

  // dacă tabela nu există sau nu e row, src poate fi null
  if (sErr) return { quiz, source_text: null, topic_payload: null };
  return { quiz, source_text: src?.source_text || null, topic_payload: src?.topic_payload || null };
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

// GET one quiz + questions
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
    const numberOfQuestions = clamp(safeNumber(req.body.numberOfQuestions, 10), 3, 20);
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");
    const user_id = normalizeUserId(req.body.user_id);

    const parsed = await pdfParse(file.buffer);
    const text = (parsed.text || "").trim();
    if (!text) return res.status(400).json({ error: "Could not extract text from PDF" });

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
      variationSeed: null,
    });

    // IMPORTANT: salvăm și textul pentru regenerate
    const quiz_id = await saveQuizToDb({
      user_id,
      title: quiz.title || "Quiz",
      language,
      source_type: "pdf",
      source_meta: { filename: file.originalname, size: file.size },
      settings: { numberOfQuestions, difficulty },
      questions: quiz.questions || [],
      source_text: text,
      topic_payload: null,
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
    const numberOfQuestions = clamp(safeNumber(req.body.numberOfQuestions, 10), 3, 20);
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");
    const user_id = normalizeUserId(req.body.user_id);

    let text = "";
    for (const f of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.mimetype)) {
        return res.status(400).json({ error: "Invalid image type (use jpg/png/webp)" });
      }
      // OCR eng – dacă vrei RO stabil, facem OCR altfel (mai târziu)
      const r = await Tesseract.recognize(f.buffer, "eng");
      text += "\n" + (r.data.text || "");
    }

    text = text.trim();
    if (!text) return res.status(400).json({ error: "OCR produced no text" });

    const quiz = await generateQuiz({
      language,
      sourceText: text,
      options: { numberOfQuestions, difficulty },
      variationSeed: null,
    });

    const quiz_id = await saveQuizToDb({
      user_id,
      title: quiz.title || "Quiz",
      language,
      source_type: "images",
      source_meta: { count: files.length },
      settings: { numberOfQuestions, difficulty },
      questions: quiz.questions || [],
      source_text: text,
      topic_payload: null,
    });

    res.json({ ...quiz, quiz_id });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// TOPIC -> generate -> save -> return
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const user_id = normalizeUserId(req.body.user_id);
    const language = normalizeLanguage(req.body.language);
    const numberOfQuestions = clamp(safeNumber(req.body.numberOfQuestions, 10), 3, 20);
    const difficulty = normalizeDifficulty(req.body.difficulty || "medium");

    const subject = String(req.body.subject || "").trim();
    const profile = String(req.body.profile || "").trim();
    const topic = String(req.body.topic || "").trim();

    if (!subject) return res.status(400).json({ error: "Missing subject (Materie)" });

    // Construim un "sourceText" stabil din datele userului.
    // IMPORTANT: aici nu inventăm lecții complete; îl tratăm ca “brief” și lăsăm AI să creeze întrebări generale.
    const brief = [
      `Materie: ${subject}`,
      profile ? `Profil: ${profile}` : "",
      topic ? `Subiect: ${topic}` : "",
      `Nivel: ${String(req.body.level || "").trim()}`,
      `Instituție: ${String(req.body.institution || "").trim()}`,
      `Clasă: ${String(req.body.classYear || "").trim()}`,
      `An facultate: ${String(req.body.facultyYear || "").trim()}`,
      `Master: ${String(req.body.masterYear || "").trim()}`,
      `Doctorat: ${String(req.body.phdYear || "").trim()}`,
      "",
      "Creează întrebări de teorie și aplicație generale pe această temă, fără să inventezi detalii foarte specifice (legi/articole/cifre) dacă nu sunt date.",
    ]
      .filter(Boolean)
      .join("\n");

    const quiz = await generateQuiz({
      language,
      sourceText: brief,
      options: { numberOfQuestions, difficulty },
      variationSeed: null,
    });

    const topic_payload = {
      user_id,
      language,
      numberOfQuestions,
      difficulty,
      level: req.body.level || "",
      institution: req.body.institution || "",
      classYear: req.body.classYear || "",
      facultyYear: req.body.facultyYear || "",
      masterYear: req.body.masterYear || "",
      phdYear: req.body.phdYear || "",
      subject,
      profile,
      topic,
      questionType: req.body.questionType || "mcq4",
    };

    const quiz_id = await saveQuizToDb({
      user_id,
      title: quiz.title || `Quiz: ${subject}`,
      language,
      source_type: "topic",
      source_meta: { subject, profile, topic },
      settings: { numberOfQuestions, difficulty, subject, profile, topic },
      questions: quiz.questions || [],
      source_text: brief,       // salvăm și brief-ul
      topic_payload,            // salvăm payload complet pt regenerate
    });

    res.json({ ...quiz, quiz_id });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ✅ REGENERATE: Alt quiz pe aceeași temă (topic + pdf + images)
app.post("/api/quiz/regenerate", async (req, res) => {
  try {
    const quiz_id = String(req.body.quiz_id || "").trim();
    const user_id = normalizeUserId(req.body.user_id);

    if (!quiz_id) return res.status(400).json({ error: "Missing quiz_id" });

    const { quiz, source_text, topic_payload } = await getQuizWithSource(quiz_id);

    // securitate minimă: userul să regenereze doar ale lui (guest id)
    if (String(quiz.user_id) !== String(user_id)) {
      return res.status(403).json({ error: "Not allowed for this user_id" });
    }

    const language = normalizeLanguage(quiz.language || "ro");
    const settings = quiz.settings || {};
    const numberOfQuestions = clamp(safeNumber(settings.numberOfQuestions, 10), 3, 20);
    const difficulty = normalizeDifficulty(settings.difficulty || "medium");

    const seed = Date.now() + "_" + Math.random().toString(16).slice(2, 8);

    // dacă e topic, preferăm topic_payload/brief
    let newSourceText = source_text || "";
    let newTopicPayload = topic_payload || null;

    if (String(quiz.source_type).toLowerCase() === "topic" && topic_payload) {
      // reconstruim brief-ul din payload ca să fie stabil
      const p = topic_payload;
      const brief = [
        `Materie: ${p.subject || ""}`,
        p.profile ? `Profil: ${p.profile}` : "",
        p.topic ? `Subiect: ${p.topic}` : "",
        `Nivel: ${p.level || ""}`,
        `Instituție: ${p.institution || ""}`,
        `Clasă: ${p.classYear || ""}`,
        `An facultate: ${p.facultyYear || ""}`,
        `Master: ${p.masterYear || ""}`,
        `Doctorat: ${p.phdYear || ""}`,
        "",
        "Creează întrebări de teorie și aplicație generale pe această temă, fără detalii foarte specifice dacă nu sunt date.",
      ]
        .filter(Boolean)
        .join("\n");

      newSourceText = brief;
    }

    if (!newSourceText.trim()) {
      return res.status(400).json({
        error:
          "Nu am source_text salvat pentru acest quiz. Verifică tabela quiz_sources și că ai redeploy cu noul server.js.",
      });
    }

    const newQuiz = await generateQuiz({
      language,
      sourceText: newSourceText,
      options: { numberOfQuestions, difficulty },
      variationSeed: seed,
    });

    // salvăm ca quiz nou
    const new_quiz_id = await saveQuizToDb({
      user_id,
      title: newQuiz.title || quiz.title || "Quiz",
      language,
      source_type: quiz.source_type, // păstrăm tipul
      source_meta: quiz.source_meta || {},
      settings: quiz.settings || {},
      questions: newQuiz.questions || [],
      source_text: newSourceText,
      topic_payload: newTopicPayload,
    });

    res.json({ ok: true, quiz_id: new_quiz_id });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ------------------- START -------------------
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log("Quiz API running on port", port));
