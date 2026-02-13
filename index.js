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

app.use(cors());
app.options("*", cors());

const PORT = Number(process.env.PORT || 8080);
const UPLOADS_DIR = path.join(__dirname, "uploads");
const RESULTS_DIR = path.join(__dirname, "results");

const REPLICATE_API_TOKEN =
  process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_TOKEN || "";

const BASE_VERSION =
  "23c6dcef1ae2b2a897b37a0f58aac044882c44f711de73225c180e6d52841ae5";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(UPLOADS_DIR);
ensureDir(RESULTS_DIR);

const presetConfig = {
  Original: { mode: "none" },

  H: {
    lora_weights: "dx8152/Qwen-Image-Edit-2509-Relight",
    lora_scale: 0.9,
    prompt: "cinematic hollywood lighting, warm glow, soft shadows"
  },

  C: {
    lora_weights: "dx8152/Qwen-Image-Edit-2509-Light_restoration",
    lora_scale: 0.9,
    prompt: "cool studio lighting, balanced shadows, clean tone"
  },

  N: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 0.9,
    prompt: "natural beauty retouch, realistic skin texture"
  },

  F: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 1.2,
    prompt: "dramatic editorial look, higher contrast"
  },

  M: {
    lora_weights: "tlennon-ie/qwen-edit-skin",
    lora_scale: 1.0,
    prompt: "high-end fashion portrait, refined details"
  },

  E: {
    lora_weights: "dx8152/Qwen-Image-Edit-2509-Light_restoration",
    lora_scale: 0.8,
    prompt: "elegant soft portrait lighting"
  }
};

function newJobId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function createPrediction(input) {
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: BASE_VERSION,
      input
    })
  });

  return res.json();
}

async function getPrediction(id) {
  const res = await fetch(
    `https://api.replicate.com/v1/predictions/${id}`,
    { headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` } }
  );

  return res.json();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${Math.random().toString(16)}.jpg`)
});

const upload = multer({ storage });

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/v1/impression", upload.single("image"), async (req, res) => {
  const jobId = newJobId();
  const preset = req.body?.preset || "Original";

  if (!req.file?.path)
    return res.status(400).json({ error: "Image required" });

  const config = presetConfig[preset];
  if (!config)
    return res.status(400).json({ error: "Unknown preset" });

  const outputPath = path.join(RESULTS_DIR, `${jobId}.jpg`);

  if (config.mode === "none") {
    fs.copyFileSync(req.file.path, outputPath);
    return res.json({ ok: true, jobId, status: "done", filename: `${jobId}.jpg` });
  }

  const dataUrl = toDataUrl(req.file.path);

  const prediction = await createPrediction({
    image: dataUrl,
    prompt: config.prompt,
    lora_weights: config.lora_weights,
    lora_scale: config.lora_scale,
    output_format: "jpg"
  });

  res.json({ ok: true, jobId, status: "processing" });

  const interval = setInterval(async () => {
    const status = await getPrediction(prediction.id);

    if (status.status === "succeeded") {
      const imageUrl = status.output;
      const imgRes = await fetch(imageUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      fs.writeFileSync(outputPath, buffer);
      clearInterval(interval);
    }

    if (status.status === "failed") {
      clearInterval(interval);
    }
  }, 2000);
});

app.get("/v1/result/:filename", (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "Not found" });
  res.sendFile(filePath);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on ${PORT}`)
);
