import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/**
 * -------------------------
 * Config
 * -------------------------
 */
const PORT = Number(process.env.PORT || 8080);

// Where we keep incoming uploads (temp) and generated results
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(__dirname, "results");

// Replicate
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_TOKEN || "";
// GFPGAN on Replicate (version hash). You can override via env.
const REPLICATE_GFPGAN_VERSION =
  process.env.REPLICATE_GFPGAN_VERSION ||
  "a5387bf23f8d1aa78df04a58238988650f165ce65f9529f628143505686e58a9";

/**
 * -------------------------
 * Helpers
 * -------------------------
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeExtFromMimetype(mimetype) {
  if (!mimetype) return ".jpg";
  if (mimetype.includes("png")) return ".png";
  if (mimetype.includes("webp")) return ".webp";
  if (mimetype.includes("jpeg") || mimetype.includes("jpg")) return ".jpg";
  return ".jpg";
}

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  // Best-effort mime by extension
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
      ? "image/webp"
      : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function replicateCreatePrediction({ version, input }) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error("REPLICATE_API_TOKEN is missing. Add it in Railway Variables.");
  }

  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version, input }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.detail || json?.error || JSON.stringify(json);
    throw new Error(`Replicate create prediction failed (${res.status}): ${detail}`);
  }
  return json;
}

async function replicateGetPrediction(id) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error("REPLICATE_API_TOKEN is missing. Add it in Railway Variables.");
  }

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.detail || json?.error || JSON.stringify(json);
    throw new Error(`Replicate get prediction failed (${res.status}): ${detail}`);
  }
  return json;
}

async function waitForReplicate(id, { timeoutMs = 120000, pollMs = 1500 } = {}) {
  const started = Date.now();
  while (true) {
    const p = await replicateGetPrediction(id);

    if (p.status === "succeeded") return p;
    if (p.status === "failed" || p.status === "canceled") {
      const err = p.error || "Unknown Replicate error";
      throw new Error(`Replicate failed: ${err}`);
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error("Replicate timeout: still not finished");
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download result (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
}

function newJobId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function jobFilePath(jobId) {
  return path.join(RESULTS_DIR, `${jobId}.json`);
}

function writeJob(jobId, data) {
  fs.writeFileSync(jobFilePath(jobId), JSON.stringify(data, null, 2));
}

function readJob(jobId) {
  const p = jobFilePath(jobId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * -------------------------
 * Init dirs
 * -------------------------
 */
ensureDir(UPLOADS_DIR);
ensureDir(RESULTS_DIR);

/**
 * -------------------------
 * Multer for multipart/form-data
 * -------------------------
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = safeExtFromMimetype(file.mimetype);
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

/**
 * -------------------------
 * Routes
 * -------------------------
 */

// Simple health check
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /v1/impression
 * multipart/form-data:
 *  - image: (file) required
 *  - preset: (string) optional. Example: "Beauty"
 *
 * Response: { ok, jobId, status, preset }
 */
app.post("/v1/impression", upload.single("image"), async (req, res) => {
  const jobId = newJobId();
  const preset = (req.body?.preset || "Original").toString();

  if (!req.file?.path) {
    return res.status(400).json({ ok: false, error: "image is required (field name: image)" });
  }

  // Create job record right away
  writeJob(jobId, {
    ok: true,
    jobId,
    status: "queued",
    preset,
    createdAt: new Date().toISOString(),
  });

  // Process async
  setImmediate(async () => {
    const startedAt = new Date().toISOString();
    const inputPath = req.file.path;

    try {
      const outExt = path.extname(inputPath) || ".jpg";
      const outName = `${jobId}${outExt}`;
      const outPath = path.join(RESULTS_DIR, outName);

      // 1) If preset is Original -> just copy
      if (preset.toLowerCase() === "original") {
        fs.copyFileSync(inputPath, outPath);

        writeJob(jobId, {
          ok: true,
          jobId,
          status: "done",
          preset,
          createdAt: startedAt,
          finishedAt: new Date().toISOString(),
          filename: outName,
        });
        return;
      }

      // 2) Otherwise -> run GFPGAN on Replicate
      const dataUrl = toDataUrl(inputPath);

      const prediction = await replicateCreatePrediction({
        version: REPLICATE_GFPGAN_VERSION,
        input: {
          img: dataUrl,
          scale: 2,
        },
      });

      const done = await waitForReplicate(prediction.id, { timeoutMs: 180000, pollMs: 1500 });

      // Output can be string URL or array of URLs
      const output = done.output;
      const url = Array.isArray(output) ? output[output.length - 1] : output;

      if (!url || typeof url !== "string") {
        throw new Error(`Unexpected Replicate output: ${JSON.stringify(output)}`);
      }

      await downloadToFile(url, outPath);

      writeJob(jobId, {
        ok: true,
        jobId,
        status: "done",
        preset,
        createdAt: startedAt,
        finishedAt: new Date().toISOString(),
        filename: outName,
        replicate: { id: done.id },
      });
    } catch (e) {
      writeJob(jobId, {
        ok: true,
        jobId,
        status: "error",
        preset,
        createdAt: startedAt,
        finishedAt: new Date().toISOString(),
        error: e?.message || String(e),
      });
    } finally {
      // cleanup upload temp file
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
  });

  return res.json({ ok: true, jobId, status: "queued", preset });
});

/**
 * GET /v1/jobs/:jobId
 * Returns job status JSON
 */
app.get("/v1/jobs/:jobId", (req, res) => {
  const job = readJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  return res.json(job);
});

/**
 * GET /v1/result/:filename
 * Downloads resulting file
 */
app.get("/v1/result/:filename", (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  return res.sendFile(filePath);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
