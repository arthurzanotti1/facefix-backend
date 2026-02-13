import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/**
 * CORS (fix "Failed to fetch" in Rork web preview / browsers)
 */
app.use(cors({ origin: true }));
app.options("*", cors({ origin: true }));

/**
 * Config
 */
const PORT = Number(process.env.PORT || 8080);
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(__dirname, "results");

const REPLICATE_API_TOKEN =
  process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_TOKEN || "";

/**
 * Qwen Image Edit base version:
 * We vary style via LoRA + prompt (so presets are actually different).
 */
const REPLICATE_QWEN_VERSION =
  process.env.REPLICATE_QWEN_VERSION ||
  "23c6dcef1ae2b2a897b37a0f58aac044882c44f711de73225c180e6d52841ae5";

/**
 * Helpers
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}
ensureDir(UPLOADS_DIR);
ensureDir(RESULTS_DIR);

function safeExtFromMimetype(mimetype) {
  if (!mimetype) return ".jpg";
  if (mimetype.includes("png")) return ".png";
  if (mimetype.includes("webp")) return ".webp";
  if (mimetype.includes("jpeg") || mimetype.includes("jpg")) return ".jpg";
  return ".jpg";
}

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
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
 * Preset mapping:
 * Rork sends full names ("Hollywood", "Cool", ...) — we accept those.
 * Also accept short codes just in case (H/C/M/E/F/N).
 */
function normalizePreset(presetRaw) {
  const s = (presetRaw || "Original").toString().trim().toLowerCase();

  if (s === "original" || s === "orig" || s === "o") return "original";

  if (s === "h" || s === "hollywood") return "hollywood";
  if (s === "c" || s === "cool") return "cool";
  if (s === "m" || s === "model") return "model";
  if (s === "e" || s === "elegant") return "elegant";
  if (s === "f" || s === "fierce") return "fierce";
  if (s === "n" || s === "natural") return "natural";

  return null;
}

const presetConfig = {
  original: { mode: "none" },

  // Hollywood: strong cinematic relight (may affect scene a bit, but gives the "glam" look)
  hollywood: {
    lora_weights: "dx8152/Qwen-Image-Edit-2509-Relight",
    lora_scale: 0.9,
    prompt:
      "portrait beauty enhancement, hollywood glamour lighting, warm soft key light on face, natural skin texture, keep identity, do not change background",
  },

  // Cool: switch to Skin LoRA so it actually edits the FACE (not just the background)
  cool: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 1.0,
    prompt:
      "portrait retouch focused on face, cooler clean look, reduce shine, refine skin tone, subtle eye clarity, keep identity, do not change background",
  },

  // Model and Natural swapped (as you requested)
  model: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 0.9,
    prompt:
      "natural beauty retouch, keep pores and skin texture, subtle improvements only, realistic, keep identity, do not change background",
  },

  elegant: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 1.0,
    prompt:
      "elegant portrait retouch, smooth but realistic skin, gentle glow on face, refined look, keep identity, do not change background",
  },

  fierce: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 1.25,
    prompt:
      "fierce editorial portrait retouch, sharper eyes, slightly higher contrast on face, crisp details, realistic skin texture, keep identity, do not change background",
  },

  natural: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 1.0,
    prompt:
      "high-end fashion model portrait retouch, refined details, clean skin tone, realistic texture, keep identity, do not change background",
  },
};

/**
 * Replicate helpers (HTTP)
 */
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

async function waitForReplicate(id, { timeoutMs = 180000, pollMs = 1500 } = {}) {
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

/**
 * Multer for multipart/form-data
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
 * Routes
 */
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /v1/impression
 * multipart/form-data:
 *  - image: (file) required
 *  - preset: (string) required: "Hollywood" | "Cool" | "Model" | "Elegant" | "Fierce" | "Natural" | "Original"
 *
 * Response: { ok, jobId, status, preset }
 */
app.post("/v1/impression", upload.single("image"), async (req, res) => {
  const jobId = newJobId();
  const presetKey = normalizePreset(req.body?.preset);

  if (!req.file?.path) {
    return res.status(400).json({ ok: false, error: "image is required (field name: image)" });
  }

  if (!presetKey || !presetConfig[presetKey]) {
    return res.status(400).json({
      ok: false,
      error: "Unknown preset",
      receivedPreset: req.body?.preset ?? null,
      allowed: ["Original", "Hollywood", "Cool", "Model", "Elegant", "Fierce", "Natural"],
    });
  }

  const presetName =
    presetKey.charAt(0).toUpperCase() + presetKey.slice(1);

  // Create job record right away
  writeJob(jobId, {
    ok: true,
    jobId,
    status: "queued",
    preset: presetName,
    createdAt: new Date().toISOString(),
  });

  // Process async
  setImmediate(async () => {
    const startedAt = new Date().toISOString();
    const inputPath = req.file.path;

    try {
      const outName = `${jobId}.jpg`;
      const outPath = path.join(RESULTS_DIR, outName);

      // Original -> copy
      if (presetKey === "original") {
        fs.copyFileSync(inputPath, outPath);

        writeJob(jobId, {
          ok: true,
          jobId,
          status: "done",
          preset: presetName,
          createdAt: startedAt,
          finishedAt: new Date().toISOString(),
          filename: outName,
        });
        return;
      }

      const cfg = presetConfig[presetKey];
      const dataUrl = toDataUrl(inputPath);

      const prediction = await replicateCreatePrediction({
        version: REPLICATE_QWEN_VERSION,
        input: {
          image: dataUrl,
          prompt: cfg.prompt,
          lora_weights: cfg.lora_weights,
          lora_scale: cfg.lora_scale,
          output_format: "jpg",
        },
      });

      const done = await waitForReplicate(prediction.id, { timeoutMs: 180000, pollMs: 1500 });

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
        preset: presetName,
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
        preset: presetName,
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

  return res.json({ ok: true, jobId, status: "queued", preset: presetName });
});

/**
 * GET /v1/jobs/:jobId
 */
app.get("/v1/jobs/:jobId", (req, res) => {
  const job = readJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  return res.json(job);
});

/**
 * GET /v1/result/:filename
 */
app.get("/v1/result/:filename", (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.sendFile(filePath);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
