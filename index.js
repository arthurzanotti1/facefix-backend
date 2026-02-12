import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.json({ message: "FaceFix Backend Running 🚀" });
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
