/**
 * server.js — COMPLET (ESM) — gata de lipit
 * - Express API pentru QuizRo
 * - Supabase (quizzes + questions)
 * - OpenAI pentru generare întrebări
 * - Fix important: user_id NU mai ajunge NULL (se ia din body/form-data)
 * - Output OpenAI este “curățat” (scoate ```json ... ```)
 *
 * Necesită în Render / ENV:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENAI_API_KEY
 *   ALLOWED_ORIGIN (ex: https://smartquizro-com-467810.hostingersite.com)  sau "*" (temporar)
 *   PORT (Render îl setează singur; local poți pune 10000)
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import pdfParse from "pdf-parse";

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// ---------- BASIC GUARDS ----------
if (!SUPABASE_URL) console.warn("⚠️ SUPABASE_URL lipsă (ENV).");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("⚠️ SUPABASE_SERVICE_ROLE_KEY lipsă (ENV).");
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY lipsă (ENV).");

// ---------- CLIENTS ----------
const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "", {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY || "" });

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    credentials: false,
  })
);

// multer pentru PDF + imagini
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- HELPERS ----------
function safeUserId(req) {
  // IMPORTANT: la multipart/form-data (multer), req.body există cu stringuri
  const raw =
    req.body?.user_id ||
    req.body?.userId ||
    req.query?.user_id ||
    req.headers["x-user-id"];

  const s = (raw || "").toString().trim();
  if (s) return s;

  // fallback (nu ar trebui să ajungă aici dacă frontend trimite user_id)
  return "guest_" + Math.random().toString(36).slice(2, 10);
}

function stripCodeFences(text) {
  // scoate ```json ... ``` sau ``` ... ```
  if (!text) return "";
  let t = text.trim();

  // dacă începe cu ```
  if (t.startsWith("```")) {
    // taie prima linie ```json sau ```
    const firstNewline = t.indexOf("\n");
    if (firstNewline !== -1) t = t.slice(firstNewline + 1);
    // taie ultima apariție ```
    const lastFence = t.lastIndexOf("```");
    if (lastFence !== -1) t = t.slice(0, lastFence);
  }

  // mai scoate eventualele “```json” rămase
  t = t.replace(/^json\s*/i, "").trim();
  return t;
}

function tryParseJSON(maybeJSON) {
  const cleaned = stripCodeFences(maybeJSON);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

// încearcă insert cu câmpuri care poate există / poate nu în schema ta
async function supabaseInsertSmart(table, payload) {
  // încercăm prima dată cu payload complet
  let { data, error } = await supabase.from(table).insert(payload).select("*").single();

  if (!error) return { data, error: null };

  // dacă eroarea e de tip “Could not find the 'X' column”
  // atunci eliminăm câmpul X și reîncercăm (într-o buclă limitată)
  let p = { ...payload };
  for (let i = 0; i < 10; i++) {
    const msg = (error?.message || "").toString();
    const m = msg.match(/Could not find the '([^']+)' column/i);
    if (!m) break;

    const missingCol = m[1];
    delete p[missingCol];

    ({ data, error } = await supabase.from(table).insert(p).select("*").single());
    if (!error) return { data, error: null };
  }

  return { data: null, error };
}

function normalizeQuestions(raw) {
  // Acceptă: array de întrebări sau obiect cu {questions:[...]}
  const arr = Array.isArray(raw) ? raw : raw?.questions;
  if (!Array.isArray(arr)) return [];

  return arr
    .map((q, idx) => {
      const question = (q.question || q.q || "").toString().trim();
      const options = Array.isArray(q.options) ? q.options.map(String) : [];
      const answer_index =
        Number.isFinite(q.answer_index) ? q.answer_index :
        Number.isFinite(q.correct_index) ? q.correct_index :
        Number.isFinite(q.answerIndex) ? q.answerIndex :
        (typeof q.correct === "number" ? q.correct : null);

      const explanation = (q.explanation || q.exp || "").toString().trim();

      return {
        idx,
        question,
        options,
        answer_index: Number.isFinite(answer_index) ? answer_index : 0,
        explanation,
      };
    })
    .filter((q) => q.question && q.options.length >= 2);
}

function buildPrompt({ sourceText, topic, subject, profile, language, difficulty, count }) {
  const lang = language || "Română";
  const diff = difficulty || "Mediu";
  const n = count || 10;

  // Prompt orientat spre calitate (întrebări mai bune)
  // Output strict JSON (fără markdown)
  return `
Ești un profesor excelent. Creează un quiz de calitate foarte mare (grilă, 3-4 variante) pe baza materialului dat.

CERINȚE:
- Limba: ${lang}
- Dificultate: ${diff}
- Număr întrebări: ${n}
- Întrebările trebuie să fie precise, să testeze înțelegerea, nu doar memorarea.
- Evită ambiguitățile și întrebările “banale”.
- Fiecare întrebare are 4 opțiuni (A/B/C/D) (sau minim 3 dacă e necesar).
- Exact un singur răspuns corect.
- Include o explicație scurtă pentru răspunsul corect (2-4 propoziții).

CONTEXT (dacă există):
- Materie: ${subject || "(nespecificat)"}
- Subiect: ${topic || "(nespecificat)"}
- Profil: ${profile || "(nespecificat)"}

MATERIAL:
${sourceText}

FORMAT OUTPUT (STRICT JSON, fără \`\`\`, fără text extra):
{
  "questions": [
    {
      "question": "…",
      "options": ["…","…","…","…"],
      "answer_index": 0,
      "explanation": "…"
    }
  ]
}
`.trim();
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.json({ ok: true, status: "Quiz API running" }));
app.get("/health", (req, res) => res.json({ ok: true, status: "Quiz API running" }));

/**
 * GET quiz complet (quiz + questions) — folosit de pagina /quiz-play
 */
app.get("/api/quiz/:quiz_id", async (req, res) => {
  try {
    const quizId = req.params.quiz_id;

    const { data: quiz, error: qErr } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .single();

    if (qErr) return res.status(404).json({ error: qErr.message });

    const { data: questions, error: qsErr } = await supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", quizId)
      .order("idx", { ascending: true });

    if (qsErr) return res.status(500).json({ error: qsErr.message });

    return res.json({ quiz, questions });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * POST /api/quiz/topic
 * body JSON:
 * { user_id, topic, subject, profile, language, difficulty, count }
 */
app.post("/api/quiz/topic", async (req, res) => {
  try {
    const userId = safeUserId(req);

    const {
      topic = "",
      subject = "",
      profile = "",
      language = "Română",
      difficulty = "Mediu",
      count = 10,
    } = req.body || {};

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY lipsește în ENV (Render)." });
    }

    if (!topic && !subject) {
      return res.status(400).json({ error: "Lipsește topic/subject. Trimite minim un subiect." });
    }

    const sourceText = `Quiz pe tema: ${topic || subject}\nMateria: ${subject || ""}\nProfil: ${profile || ""}`;
    const prompt = buildPrompt({ sourceText, topic, subject, profile, language, difficulty, count });

    const ai = await openai.responses.create({
      model: "gpt-4o-mini", // rapid + suficient pentru quiz; poți schimba cu "gpt-4o" dacă vrei calitate mai mare
      input: prompt,
      temperature: 0.9,
      max_output_tokens: 2000,
    });

    const rawText = ai.output_text || "";
    const parsed = tryParseJSON(rawText);
    if (!parsed) {
      return res.status(500).json({
        error: `OpenAI a returnat ceva ce nu e JSON valid.`,
        raw: rawText.slice(0, 300),
      });
    }

    const questionsNorm = normalizeQuestions(parsed);
    if (questionsNorm.length === 0) {
      return res.status(500).json({ error: "Nu am putut extrage întrebări valide din output." });
    }

    // 1) insert quiz (IMPORTANT: user_id obligatoriu)
    const quizPayload = {
      user_id: userId,
      source_type: "topic",
      source_text: sourceText,
      topic: topic || subject,
      subject: subject || null,
      profile: profile || null,
      language,
      difficulty,
      question_count: questionsNorm.length,
    };

    const { data: quizRow, error: quizErr } = await supabaseInsertSmart("quizzes", quizPayload);
    if (quizErr) return res.status(500).json({ error: quizErr.message });

    const quizId = quizRow.id;

    // 2) insert questions
    const qRows = questionsNorm.map((q) => ({
      quiz_id: quizId,
      idx: q.idx,
      position: q.idx, // dacă ai și position în schemă, îl umplem
      question: q.question,
      options: q.options,
      answer_index: q.answer_index,
      explanation: q.explanation,
    }));

    // inserare în bulk; dacă schema nu are unele coloane, scoatem automat
    // (în practică, de obicei ai idx/quiz_id/question/options/answer_index/explanation)
    let { error: insErr } = await supabase.from("questions").insert(qRows);
    if (insErr) {
      // fallback: dacă există coloane lipsă
      // încercăm să prindem missing column și să reinserăm fără ea
      // (simplu: reinserăm fără position dacă e problema)
      const msg = (insErr.message || "").toString();
      if (/Could not find the 'position' column/i.test(msg)) {
        const qRows2 = qRows.map(({ position, ...rest }) => rest);
        const { error: insErr2 } = await supabase.from("questions").insert(qRows2);
        if (insErr2) return res.status(500).json({ error: insErr2.message });
      } else {
        return res.status(500).json({ error: insErr.message });
      }
    }

    // Return pentru frontend
    return res.json({
      quiz_id: quizId,
      model_used: ai.model || "unknown",
      questions_count: questionsNorm.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * POST /api/quiz/pdf
 * multipart/form-data:
 * - pdf: file
 * - user_id, subject, profile, topic, language, difficulty, count (strings)
 */
app.post("/api/quiz/pdf", upload.single("pdf"), async (req, res) => {
  try {
    const userId = safeUserId(req);

    const subject = (req.body?.subject || "").toString();
    const profile = (req.body?.profile || "").toString();
    const topic = (req.body?.topic || req.body?.subject || "").toString();
    const language = (req.body?.language || "Română").toString();
    const difficulty = (req.body?.difficulty || "Mediu").toString();
    const count = Number(req.body?.count || 10);

    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Nu am primit PDF. (field name trebuie să fie 'pdf')" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY lipsește în ENV (Render)." });
    }

    // extragem text din PDF
    const pdfData = await pdfParse(req.file.buffer);
    const extracted = (pdfData.text || "").trim();

    if (!extracted || extracted.length < 50) {
      return res.status(400).json({
        error: "Nu am putut extrage suficient text din PDF. Încearcă alt PDF sau unul scanat nu merge fără OCR.",
      });
    }

    // limităm materialul ca să nu fie enorm
    const sourceText = extracted.slice(0, 18000);

    const prompt = buildPrompt({ sourceText, topic, subject, profile, language, difficulty, count });

    const ai = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      temperature: 0.9,
      max_output_tokens: 2200,
    });

    const rawText = ai.output_text || "";
    const parsed = tryParseJSON(rawText);
    if (!parsed) {
      return res.status(500).json({
        error: `Unexpected token / output OpenAI nu e JSON valid.`,
        raw: rawText.slice(0, 300),
      });
    }

    const questionsNorm = normalizeQuestions(parsed);
    if (questionsNorm.length === 0) {
      return res.status(500).json({ error: "Nu am putut extrage întrebări valide din output." });
    }

    // 1) insert quiz (IMPORTANT: user_id obligatoriu)
    const quizPayload = {
      user_id: userId,
      source_type: "pdf",
      source_text: sourceText,
      topic: topic || subject || "PDF",
      subject: subject || null,
      profile: profile || null,
      language,
      difficulty,
      question_count: questionsNorm.length,
    };

    const { data: quizRow, error: quizErr } = await supabaseInsertSmart("quizzes", quizPayload);
    if (quizErr) return res.status(500).json({ error: quizErr.message });

    const quizId = quizRow.id;

    // 2) insert questions
    const qRows = questionsNorm.map((q) => ({
      quiz_id: quizId,
      idx: q.idx,
      position: q.idx,
      question: q.question,
      options: q.options,
      answer_index: q.answer_index,
      explanation: q.explanation,
    }));

    let { error: insErr } = await supabase.from("questions").insert(qRows);
    if (insErr) {
      const msg = (insErr.message || "").toString();
      if (/Could not find the 'position' column/i.test(msg)) {
        const qRows2 = qRows.map(({ position, ...rest }) => rest);
        const { error: insErr2 } = await supabase.from("questions").insert(qRows2);
        if (insErr2) return res.status(500).json({ error: insErr2.message });
      } else {
        return res.status(500).json({ error: insErr.message });
      }
    }

    return res.json({
      quiz_id: quizId,
      model_used: ai.model || "unknown",
      questions_count: questionsNorm.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * POST /api/quiz/images
 * multipart/form-data:
 * - images: multiple files
 * - user_id, subject, profile, topic, language, difficulty, count
 *
 * Observație: dacă vrei calitate maximă pe imagini, trebuie “vision”.
 * Mai jos facem vision simplu cu OpenAI (input_image).
 */
app.post("/api/quiz/images", upload.array("images", 10), async (req, res) => {
  try {
    const userId = safeUserId(req);

    const subject = (req.body?.subject || "").toString();
    const profile = (req.body?.profile || "").toString();
    const topic = (req.body?.topic || req.body?.subject || "").toString();
    const language = (req.body?.language || "Română").toString();
    const difficulty = (req.body?.difficulty || "Mediu").toString();
    const count = Number(req.body?.count || 10);

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "Nu am primit imagini. (field name trebuie să fie 'images')" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY lipsește în ENV (Render)." });
    }

    // Construim input multimodal (vision) pentru a “citi” imaginile
    const input = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extrage ideile/definițiile din imaginile următoare și creează un quiz de calitate pe baza lor. Returnează STRICT JSON." },
          ...files.map((f) => ({
            type: "input_image",
            image_url: `data:${f.mimetype};base64,${f.buffer.toString("base64")}`,
          })),
          {
            type: "input_text",
            text: buildPrompt({
              sourceText: "Materialul este în imagini (note/poze).",
              topic,
              subject,
              profile,
              language,
              difficulty,
              count,
            }),
          },
        ],
      },
    ];

    const ai = await openai.responses.create({
      model: "gpt-4o-mini",
      input,
      temperature: 0.9,
      max_output_tokens: 2200,
    });

    const rawText = ai.output_text || "";
    const parsed = tryParseJSON(rawText);
    if (!parsed) {
      return res.status(500).json({
        error: `Output OpenAI nu e JSON valid.`,
        raw: rawText.slice(0, 300),
      });
    }

    const questionsNorm = normalizeQuestions(parsed);
    if (questionsNorm.length === 0) {
      return res.status(500).json({ error: "Nu am putut extrage întrebări valide din output." });
    }

    // 1) insert quiz (IMPORTANT: user_id obligatoriu)
    const quizPayload = {
      user_id: userId,
      source_type: "images",
      source_text: "Material din imagini (vision).",
      topic: topic || subject || "Images",
      subject: subject || null,
      profile: profile || null,
      language,
      difficulty,
      question_count: questionsNorm.length,
    };

    const { data: quizRow, error: quizErr } = await supabaseInsertSmart("quizzes", quizPayload);
    if (quizErr) return res.status(500).json({ error: quizErr.message });

    const quizId = quizRow.id;

    // 2) insert questions
    const qRows = questionsNorm.map((q) => ({
      quiz_id: quizId,
      idx: q.idx,
      position: q.idx,
      question: q.question,
      options: q.options,
      answer_index: q.answer_index,
      explanation: q.explanation,
    }));

    let { error: insErr } = await supabase.from("questions").insert(qRows);
    if (insErr) {
      const msg = (insErr.message || "").toString();
      if (/Could not find the 'position' column/i.test(msg)) {
        const qRows2 = qRows.map(({ position, ...rest }) => rest);
        const { error: insErr2 } = await supabase.from("questions").insert(qRows2);
        if (insErr2) return res.status(500).json({ error: insErr2.message });
      } else {
        return res.status(500).json({ error: insErr.message });
      }
    }

    return res.json({
      quiz_id: quizId,
      model_used: ai.model || "unknown",
      questions_count: questionsNorm.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ Quiz API running on ${PORT}`);
});
