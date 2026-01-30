import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3001;

/* =========================
   CONFIG
========================= */

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*"
}));
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

/* =========================
   SUPABASE
========================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({ ok: true, status: "Quiz API running" });
});

/* =========================
   OPENAI HELPER
========================= */

async function callOpenAI(prompt, temperature = 0.8) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY lipsă din environment");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      messages: [
        {
          role: "system",
          content: "Ești un generator de quiz-uri educaționale foarte precise."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Eroare OpenAI");
  }

  return data.choices[0].message.content;
}

/* =========================
   PDF → QUIZ
========================= */

app.post("/api/quiz/pdf", upload.single("file"), async (req, res) => {
  try {
    const buffer = req.file.buffer;
    const parsed = await pdf(buffer);
    const text = parsed.text.slice(0, 12000);

    const prompt = `
Generează 10 întrebări grilă (3 variante) din textul de mai jos.
Limba: română.
Răspunde STRICT în JSON cu format:
[
  {
    "question": "...",
    "choices": ["A","B","C"],
    "answer": "A"
  }
]

TEXT:
${text}
`;

    const aiRaw = await callOpenAI(prompt);
    const questions = JSON.parse(aiRaw);

    const { data: quiz } = await supabase
      .from("quizzes")
      .insert({ title: "Quiz din PDF", language: "ro", source_type: "pdf" })
      .select()
      .single();

    for (let i = 0; i < questions.length; i++) {
      await supabase.from("questions").insert({
        quiz_id: quiz.id,
        idx: i + 1,
        question: questions[i].question,
        choices: questions[i].choices,
        answer: questions[i].answer
      });
    }

    res.json({ quiz_id: quiz.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log("✅ Quiz API running on", PORT);
});
