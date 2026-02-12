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
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

// ---------- in-memory jobs (пока без БД) ----------
const jobs = new Map(); // jobId -> { status, createdAt, filename, preset }

app.post("/v1/impression", upload.single("image"), (req, res) => {
  // fields: preset (string)
  const preset = String(req.body?.preset || "Original");

  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No image file. Use field name 'image'." });
  }

  const jobId = uuidv4();

  jobs.set(jobId, {
    status: "queued",
    createdAt: new Date().toISOString(),
    filename: req.file.filename,
    preset,
  });

  // Пока “фейково” завершаем задачу через 2 секунды
  setTimeout(() => {
    const j = jobs.get(jobId);
    if (j) jobs.set(jobId, { ...j, status: "done" });
  }, 2000);

  return res.json({
    ok: true,
    jobId,
    status: "queued",
    preset,
  });
});

app.get("/v1/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });

  res.json({ ok: true, jobId, ...job });
});

// ---------- start ----------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
