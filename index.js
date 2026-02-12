import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import Replicate from "replicate";

const app = express();

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// ---------- health ----------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ---------- dirs ----------
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const RESULTS_DIR = path.join(process.cwd(), "results");

for (const dir of [UPLOAD_DIR, RESULTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- multer ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ---------- in-memory jobs ----------
/**
 * jobId -> {
 *   status: 'queued'|'processing'|'done'|'error',
 *   createdAt,
 *   preset,
 *   inputFilename,
 *   resultFilename?,
 *   error?
 * }
 */
const jobs = new Map();

// ---------- helpers ----------
async function downloadToFile(url, outPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download: ${r.status} ${r.statusText}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function guessExtFromUrl(url) {
  const clean = url.split("?")[0];
  const ext = path.extname(clean).toLowerCase();
  return ext || ".jpg";
}

// ---------- main endpoint ----------
app.post("/v1/impression", upload.single("image"), async (req, res) => {
  const preset = String(req.body?.preset || "Original");

  if (!req.file) {
    return res
      .status(400)
      .json({ ok: false, error: "No image file. Use field name 'image'." });
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing REPLICATE_API_TOKEN in environment variables",
    });
  }

  const jobId = uuidv4();

  jobs.set(jobId, {
    status: "queued",
    createdAt: new Date().toISOString(),
    preset,
    inputFilename: req.file.filename,
  });

  // отвечаем сразу, а обработку делаем асинхронно
  res.json({ ok: true, jobId, status: "queued", preset });

  // --- async processing ---
  (async () => {
    try {
      const current = jobs.get(jobId);
      if (!current) return;

      jobs.set(jobId, { ...current, status: "processing" });

      const inputPath = path.join(UPLOAD_DIR, current.inputFilename);

      // preset -> replicate model
      if (preset === "Original") {
        // просто копируем файл как "результат"
        const outName = `${uuidv4()}${path.extname(inputPath) || ".jpg"}`;
        fs.copyFileSync(inputPath, path.join(RESULTS_DIR, outName));
        const done = jobs.get(jobId);
        if (done) jobs.set(jobId, { ...done, status: "done", resultFilename: outName });
        return;
      }

      // Beauty -> GFPGAN (face restoration)
      // Используем модель по имени, Replicate возьмёт актуальную версию.
      // output обычно будет URL (или массив URL) — обработаем оба варианта.
      const output = await replicate.run("xinntao/gfpgan", {
        input: {
          img: fs.createReadStream(inputPath),
          version: "v1.4", // популярный вариант у GFPGAN; если модель скажет иначе — поменяем
          scale: 2,
        },
      });

      let outUrl = null;
      if (typeof output === "string") outUrl = output;
      else if (Array.isArray(output) && output.length > 0) outUrl = output[0];

      if (!outUrl) throw new Error("Replicate returned empty output");

      const outExt = guessExtFromUrl(outUrl);
      const outName = `${uuidv4()}${outExt}`;
      const outPath = path.join(RESULTS_DIR, outName);

      await downloadToFile(outUrl, outPath);

      const done = jobs.get(jobId);
      if (done) jobs.set(jobId, { ...done, status: "done", resultFilename: outName });
    } catch (e) {
      const cur = jobs.get(jobId);
      if (!cur) return;
      jobs.set(jobId, {
        ...cur,
        status: "error",
        error: String(e?.message || e),
      });
    }
  })();
});

// ---------- job status ----------
app.get("/v1/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });

  res.json({ ok: true, jobId, ...job });
});

// ---------- result file ----------
app.get("/v1/result/:filename", (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: "File not found" });
  }

  res.sendFile(filePath);
});

// ---------- start ----------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => console.log("Listening on", PORT));