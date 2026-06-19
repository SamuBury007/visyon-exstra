const express = require("express");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(cors());

// esempio video (link finto o tuo .m3u8)
const videos = {
  "786892": {
    base: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
  }
};

// genera link firmato
function generateSignedUrl(baseUrl) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = crypto.randomBytes(16).toString("hex");

  return `${baseUrl}?token=${token}&expires=${expires}`;
}

// API
app.get("/api/video/:id", (req, res) => {
  const video = videos[req.params.id];

  if (!video) {
    return res.status(404).json({ error: "Video non trovato" });
  }

  const url = generateSignedUrl(video.base);

  res.json({ url });
});

// avvio server
app.listen(3000, () => {
  console.log("Server attivo: http://localhost:3000");
});