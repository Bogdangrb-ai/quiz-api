/**
 * SmartQuiz API — server.js
 * ES MODULE (Render + Node 22)
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// =======================
// ENV
// =======================
const {
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ALLOWED_ORIGIN = "*",
  PORT = 10000,
} = process.env;

// =======================
// SANITY CHECK (IMPORTANT)
// =======================
console.log("🚀 Booting SmartQuiz API...");
console.log("OpenAI key present:", Boolean(OPENAI_API_KEY));
console.log("Using OpenAI model:", OPENAI_MODEL);
console.log("Supabase URL present:", Boolean(SUPABASE_URL));
console.log("Supabase SRK present:", Boolean(SUPABASE_SERVICE_ROLE_KEY));

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

// =======================
// INIT
// =======================
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// =======================
// MIDDLEWARE
// =======================
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "10mb" }));

// =======================
// HEALTH
// =======================
app.get("/", (_, res) => {
  res.json({ ok: true, service: "SmartQuiz API" });
});

// =======================
// HELPER — OpenAI
// =======================
async function generateQuizFromText({
  text,
  language,
  difficulty,
  numberOfQuestions,
}) {
  const prompt = `
Ești un profesor universitar.
Generează ${numberOfQuestions} întrebări GRILĂ (3 variante) din textul de mai jos.

CERINȚE STRICTE:
- limbă: ${language}
- dificultate: ${difficulty}
- exact o variantă corectă
- explicații clare, academice
- fără introduceri inutile
- răspunde STRICT în JSON

FORMAT:
{
  "title": "...",
  "questions": [
    {
      "question": "...",
      "choices": ["A", "B", "C"],
      "answer": "A",
      "explanation": "..."
    }
  ]
}

TEXT:
"""${text}"""
`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.25,
    messages: [
      { role: "system", content: "You are a strict academic examiner." },
      { role: "user", content: prompt },
    ],
  });

  return JSON.parse(completion.choices[0].message.content);
}

// =======================
// PDF QUIZ
// =======================
app.post("/api/quiz/pdf", upload.single("file"), async (req, res) => {
  try {
    const {
      user_id,
      language = "ro",
      difficulty = "medium",
      numberOfQuestions = 10,
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "PDF lipsă" });
    }

    const text = req.file.buffer.toString("utf-8");

    console.log("[OpenAI] generating quiz from PDF");

    const quizData = await generateQuizFromText({
      text,
      language,
      difficulty,
      numberOfQuestions: Number(numberOfQuestions),
    });

    const { data: quiz, error } = await supabase
      .from("quizzes")
      .insert({
        user_id,
        title: quizData.title,
        language,
        difficulty,
        source_type: "pdf",
        source_text: text,
      })
      .select()
      .single();

    if (error) throw error;

    const questions = quizData.questions.map((q, i) => ({
      quiz_id: quiz.id,
      idx: i + 1,
      question: q.question,
      choices: q.choices,
      answer: q.answer,
      explanation: q.explanation,
    }));

    await supabase.from("questions").insert(questions);

    res.json({ quiz_id: quiz.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`✅ SmartQuiz API running on ${PORT}`);
});
