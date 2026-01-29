/**
 * SmartQuiz API — server.js (cap-coadă)
 * - Express + Supabase
 * - OpenAI Responses API (JSON schema)
 * - PDF text extract (pdf-parse)
 * - Images -> text via OpenAI Vision (no OCR lib)
 * - Stores source_text for regen "same theme" without reupload
 * - Enforces max 10 quizzes / user_id
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import pdf from "pdf-parse";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" })); // JSON only

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const FREE_LIMIT = 10;
const PORT = process.env.PORT || 10000;

/* ------------------------ helpers ------------------------ */

function normLang(lang) {
  const v = String(lang || "ro").toLowerCase().trim();
  if (["ro", "en", "fr", "de", "es", "it"].includes(v)) return v;
  return "ro";
}
function langLabel(lang) {
  const m = {
    ro: "Română",
    en: "English",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    it: "Italiano"
  };
  return m[lang] || "Română";
}
function safeStr(x, max = 2000) {
  const s = String(x ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

async function openaiResponseJSON({ instructions, inputText, schema, temperature = 0.7 }) {
  const body = {
    model: OPENAI_MODEL,
    instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: inputText }]
      }
    ],
    temperature,
    text: {
      format: {
        type: "json_schema",
        name: "quiz_payload",
        schema,
        strict: true
      }
    }
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI error HTTP ${r.status}`;
    throw new Error(msg);
  }

  // Responses API return text in output[]; but with json_schema strict,
  // SDK returns parsed JSON in output_text — safest: search for output_text
  const outText =
    j?.output?.find(o => o?.type === "message")?.content?.find(c => c?.type === "output_text")?.text
    ?? j?.output_text
    ?? null;

  if (!outText) {
    // Sometimes the API returns parsed object in "output[...].content[...].parsed"
    const parsed =
      j?.output?.find(o => o?.type === "message")?.content?.find(c => c?.type === "output_text")?.parsed
      ?? j?.output_parsed
      ?? null;
    if (parsed) return parsed;
    throw new Error("OpenAI: Nu am primit output_text.");
  }

  // If it's JSON text, parse
  try {
    return JSON.parse(outText);
  } catch {
    throw new Error("OpenAI: output nu e JSON valid.");
  }
}

async function openaiExtractTextFromImages(imagesBuffers, lang) {
  // Vision: trimitem imagini ca data URLs în input
  const content = [];
  for (const buf of imagesBuffers.slice(0, 10)) {
    const b64 = buf.toString("base64");
    content.push({
      type: "input_image",
      image_url: `data:image/png;base64,${b64}`
    });
  }

  const body = {
    model: OPENAI_MODEL,
    instructions:
      `Extrage textul din imagini ca text simplu. ` +
      `Păstrează limba originală (de obicei ${langLabel(lang)}). ` +
      `Nu inventa conținut. Returnează DOAR textul.`,
    input: [{ role: "user", content }],
    temperature: 0
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI vision error HTTP ${r.status}`;
    throw new Error(msg);
  }

  const outText =
    j?.output?.find(o => o?.type === "message")?.content?.find(c => c?.type === "output_text")?.text
    ?? j?.output_text
    ?? "";

  return safeStr(outText, 200000);
}

function quizSchemaMCQ3() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      questions: {
        type: "array",
        minItems: 10,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            choices: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: { type: "string" }
            },
            answer: { type: "string" },
            explanation: { type: "string" }
          },
          required: ["question", "choices", "answer", "explanation"]
        }
      }
    },
    required: ["title", "questions"]
  };
}

async function enforceLimit(user_id) {
  // Total quizzes per user_id
  const { data, error } = await supabase
    .from("usage_counter")
    .select("total_quizzes")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const total = data?.total_quizzes ?? 0;
  if (total >= FREE_LIMIT) {
    const err = new Error(`Limită atinsă: ai folosit ${FREE_LIMIT}/${FREE_LIMIT} quiz-uri gratis.`);
    err.status = 403;
    err.code = "LIMIT_REACHED";
    throw err;
  }
  return { total, remaining: FREE_LIMIT - total };
}

async function incrementUsage(user_id) {
  const { data, error } = await supabase
    .from("usage_counter")
    .upsert({ user_id }, { onConflict: "user_id" })
    .select("total_quizzes")
    .maybeSingle();

  if (error) throw new Error(error.message);

  const current = data?.total_quizzes ?? 0;
  const next = current + 1;

  const { error: e2 } = await supabase
    .from("usage_counter")
    .update({ total_quizzes: next })
    .eq("user_id", user_id);

  if (e2) throw new Error(e2.message);
  return { total: next, remaining: Math.max(0, FREE_LIMIT - next) };
}

async function saveQuizToDB({ user_id, title, language, difficulty, source_type, source_meta, source_text, settings, questions }) {
  const { data: qz, error: qzErr } = await supabase
    .from("quizzes")
    .insert([{
      user_id,
      title,
      language,
      difficulty,
      source_type,
      source_meta: source_meta || {},
      source_text: source_text || null,
      settings: settings || {}
    }])
    .select("*")
    .single();

  if (qzErr) throw new Error(qzErr.message);

  const rows = (questions || []).map((qq, i) => ({
    quiz_id: qz.id,
    idx: i,
    question: safeStr(qq.question, 2000),
    choices: qq.choices,
    answer: safeStr(qq.answer, 1000),
    explanation: safeStr(qq.explanation, 4000)
  }));

  const { error: qsErr } = await supabase.from("questions").insert(rows);
  if (qsErr) throw new Error(qsErr.message);

  return qz;
}

function buildQuizPrompt({ language, difficulty, numberOfQuestions, contextText, meta }) {
  const lang = langLabel(language);
  const diff = difficulty === "easy" ? "ușor" : difficulty === "hard" ? "greu" : "mediu";

  const levelLine = meta?.level ? `Nivel: ${meta.level}.` : "";
  const classLine = meta?.classYear ? `Clasă: ${meta.classYear}.` : "";
  const facLine = meta?.facultyYear ? `An facultate: ${meta.facultyYear}.` : "";
  const masterLine = meta?.masterYear ? `Master anul: ${meta.masterYear}.` : "";
  const phdLine = meta?.phdYear ? `Doctorat anul: ${meta.phdYear}.` : "";
  const instLine = meta?.institution ? `Instituție: ${meta.institution}.` : "";
  const subjLine = meta?.subject ? `Materie: ${meta.subject}.` : "";
  const profLine = meta?.profile ? `Profil: ${meta.profile}.` : "";
  const topicLine = meta?.topic ? `Subiect: ${meta.topic}.` : "";

  return `
Generează EXACT ${numberOfQuestions} întrebări grilă (3 variante) în limba ${lang}.
Dificultate: ${diff}.
Fiecare întrebare:
- să aibă 3 variante (A/B/C) ca texte simple (fără literele A/B/C în text).
- să aibă 1 singur răspuns corect (answer = unul dintre choices exact).
- să aibă explicație clară (1–3 paragrafe scurte), în aceeași limbă.

Respectă 100% limba: ${lang}. Nu produce altă limbă.

Context (dacă există):
${levelLine} ${classLine} ${facLine} ${masterLine} ${phdLine}
${instLine}
${subjLine} ${profLine} ${topicLine}

Conținut din care să te bazezi (dacă există):
"""
${safeStr(contextText || "", 160000)}
"""

Dă titlu scurt și relevant.
`.trim();
}

/* ------------------------ routes ------------------------ */

app.get("/health", (_, res) => res.json({ ok: true }));

// usage counter
app.get("/api/usage", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "");
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data, error } = await supabase
      .from("usage_counter")
      .select("total_quizzes")
      .eq("user_id", user_id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    const total = data?.total_quizzes ?? 0;

    res.json({
      total,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - total),
      showUpsell: total >= 3
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// list quizzes for user
app.get("/api/quizzes", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "");
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data, error } = await supabase
      .from("quizzes")
      .select("id,title,language,difficulty,source_type,source_meta,created_at,settings")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    res.json({ quizzes: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// get quiz by id
app.get("/api/quizzes/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const { data: quiz, error: qErr } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", id)
      .single();

    if (qErr) return res.status(404).json({ error: "Quiz not found" });

    const { data: questions, error: qsErr } = await supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", id)
      .order("idx", { ascending: true });

    if (qsErr) throw new Error(qsErr.message);

    res.json({ quiz, questions: questions || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// create quiz from topic (no files)
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const payload = req.body || {};
    const user_id = String(payload.user_id || "");
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    await enforceLimit(user_id);

    const language = normLang(payload.language);
    const difficulty = String(payload.difficulty || "medium");
    const numberOfQuestions = 10;

    const source_meta = {
      level: payload.level || "",
      institution: payload.institution || "",
      classYear: payload.classYear || "",
      facultyYear: payload.facultyYear || "",
      masterYear: payload.masterYear || "",
      phdYear: payload.phdYear || "",
      subject: payload.subject || "",
      profile: payload.profile || "",
      topic: payload.topic || ""
    };

    if (!String(source_meta.subject).trim()) {
      return res.status(400).json({ error: "Materie (subject) este obligatorie în modul topic." });
    }

    const prompt = buildQuizPrompt({
      language,
      difficulty,
      numberOfQuestions,
      contextText: "", // no file
      meta: source_meta
    });

    const schema = quizSchemaMCQ3();
    const out = await openaiResponseJSON({
      instructions: "Răspunde doar în formatul cerut (JSON strict).",
      inputText: prompt,
      schema,
      temperature: 0.85
    });

    const title = safeStr(out.title || `${source_meta.subject} — Quiz`, 120);
    const questions = out.questions || [];

    const quiz = await saveQuizToDB({
      user_id,
      title,
      language,
      difficulty,
      source_type: "topic",
      source_meta,
      source_text: null,
      settings: { numberOfQuestions, questionType: "mcq3" },
      questions
    });

    const usage = await incrementUsage(user_id);

    res.json({ quiz_id: quiz.id, usage });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code || undefined });
  }
});

// create quiz from PDF
app.post("/api/quiz/pdf", upload.single("file"), async (req, res) => {
  try {
    const user_id = String(req.body.user_id || "");
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    await enforceLimit(user_id);

    const language = normLang(req.body.language);
    const difficulty = String(req.body.difficulty || "medium");
    const numberOfQuestions = 10;

    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing file" });

    // Extract text
    const parsed = await pdf(file.buffer);
    const extractedText = safeStr(parsed.text || "", 200000);

    // meta (optional)
    const source_meta = {
      filename: file.originalname || "",
      level: req.body.level || "",
      institution: req.body.institution || "",
      classYear: req.body.classYear || "",
      facultyYear: req.body.facultyYear || "",
      masterYear: req.body.masterYear || "",
      phdYear: req.body.phdYear || "",
      subject: req.body.subject || "",
      profile: req.body.profile || "",
      topic: req.body.topic || ""
    };

    const prompt = buildQuizPrompt({
      language,
      difficulty,
      numberOfQuestions,
      contextText: extractedText,
      meta: source_meta
    });

    const schema = quizSchemaMCQ3();
    const out = await openaiResponseJSON({
      instructions: "Răspunde doar în formatul cerut (JSON strict).",
      inputText: prompt,
      schema,
      temperature: 0.9
    });

    const title = safeStr(out.title || `Întrebări din ${file.originalname}`, 120);
    const questions = out.questions || [];

    const quiz = await saveQuizToDB({
      user_id,
      title,
      language,
      difficulty,
      source_type: "pdf",
      source_meta,
      source_text: extractedText, // IMPORTANT for regen
      settings: { numberOfQuestions, questionType: "mcq3" },
      questions
    });

    const usage = await incrementUsage(user_id);

    res.json({ quiz_id: quiz.id, usage });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code || undefined });
  }
});

// create quiz from Images
app.post("/api/quiz/images", upload.array("images", 10), async (req, res) => {
  try {
    const user_id = String(req.body.user_id || "");
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    await enforceLimit(user_id);

    const language = normLang(req.body.language);
    const difficulty = String(req.body.difficulty || "medium");
    const numberOfQuestions = 10;

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Missing images" });

    const buffers = files.map(f => f.buffer);
    const extractedText = await openaiExtractTextFromImages(buffers, language);

    const source_meta = {
      filenames: files.map(f => f.originalname || ""),
      level: req.body.level || "",
      institution: req.body.institution || "",
      classYear: req.body.classYear || "",
      facultyYear: req.body.facultyYear || "",
      masterYear: req.body.masterYear || "",
      phdYear: req.body.phdYear || "",
      subject: req.body.subject || "",
      profile: req.body.profile || "",
      topic: req.body.topic || ""
    };

    const prompt = buildQuizPrompt({
      language,
      difficulty,
      numberOfQuestions,
      contextText: extractedText,
      meta: source_meta
    });

    const schema = quizSchemaMCQ3();
    const out = await openaiResponseJSON({
      instructions: "Răspunde doar în formatul cerut (JSON strict).",
      inputText: prompt,
      schema,
      temperature: 0.9
    });

    const title = safeStr(out.title || `Întrebări din poze`, 120);
    const questions = out.questions || [];

    const quiz = await saveQuizToDB({
      user_id,
      title,
      language,
      difficulty,
      source_type: "images",
      source_meta,
      source_text: extractedText, // IMPORTANT for regen
      settings: { numberOfQuestions, questionType: "mcq3" },
      questions
    });

    const usage = await incrementUsage(user_id);

    res.json({ quiz_id: quiz.id, usage });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code || undefined });
  }
});

// regen "same theme" (works for topic and pdf/images because we stored source_meta/source_text)
app.post("/api/quiz/regen", async (req, res) => {
  try {
    const { quiz_id, user_id } = req.body || {};
    if (!quiz_id) return res.status(400).json({ error: "Missing quiz_id" });
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    await enforceLimit(user_id);

    const { data: quiz, error } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", quiz_id)
      .single();

    if (error || !quiz) return res.status(404).json({ error: "Quiz not found" });

    if (String(quiz.user_id) !== String(user_id)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const language = normLang(quiz.language);
    const difficulty = String(quiz.difficulty || "medium");
    const numberOfQuestions = 10;

    const meta = quiz.source_meta || {};
    const contextText = quiz.source_type === "topic" ? "" : (quiz.source_text || "");

    // dacă e pdf/images dar source_text e gol => nu putem regen fără reupload
    if ((quiz.source_type === "pdf" || quiz.source_type === "images") && !String(contextText).trim()) {
      return res.status(400).json({
        error:
          "Nu am text salvat pentru regen (source_text gol). " +
          "Generează din nou cu fișierul ca să putem salva textul."
      });
    }

    const prompt = buildQuizPrompt({
      language,
      difficulty,
      numberOfQuestions,
      contextText,
      meta
    });

    const schema = quizSchemaMCQ3();
    const out = await openaiResponseJSON({
      instructions: "Răspunde doar în formatul cerut (JSON strict).",
      inputText: prompt,
      schema,
      temperature: 0.95 // puțin mai variat la regen
    });

    const title = safeStr(out.title || quiz.title || "Quiz", 120);
    const questions = out.questions || [];

    const newQuiz = await saveQuizToDB({
      user_id,
      title,
      language,
      difficulty,
      source_type: quiz.source_type,
      source_meta: meta,
      source_text: quiz.source_type === "topic" ? null : contextText,
      settings: quiz.settings || { numberOfQuestions, questionType: "mcq3" },
      questions
    });

    const usage = await incrementUsage(user_id);

    res.json({ quiz_id: newQuiz.id, usage });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code || undefined });
  }
});

app.listen(PORT, () => console.log("Quiz API running on", PORT));
