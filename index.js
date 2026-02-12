import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

const app = express();

// ---------- health ----------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ---------- uploads dir ----------
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- results dir ----------
const RESULTS_DIR = path.join(process.cwd(), "results");
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// ---------- multer storage ----------
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
const jobs = new Map();

// ---------- POST impression ----------
app.post("/v1/impression", upload.single("image"), (req, res) => {
  const preset = String(req.body?.preset || "Original");

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "No image file. Use field name 'image'.",
    });
  }

  const jobId = uuidv4();

  jobs.set(jobId, {
    status: "queued",
    createdAt: new Date().toISOString(),
    filename: req.file.filename,
    preset,
  });

  // имитация обработки
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job) return;

    const sourcePath = path.join(UPLOAD_DIR, job.filename);
    const resultPath = path.join(RESULTS_DIR, job.filename);

    // просто копируем файл как будто он обработан
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, resultPath);
    }

    jobs.set(jobId, {
      ...job,
      status: "done",
    });
  }, 2000);

  return res.json({
    ok: true,
    jobId,
    status: "queued",
    preset,
  });
});

// ---------- GET job status ----------
app.get("/v1/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "Job not found",
    });
  }

  res.json({
    ok: true,
    jobId,
    ...job,
  });
});

// ---------- GET result file ----------
app.get("/v1/result/:filename", (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      ok: false,
      error: "Result file not found",
    });
  }

  res.sendFile(filePath);
});

// ---------- start ----------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
