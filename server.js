const express = require("express");
const videoshow = require("./lib/videoshow");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

async function downloadFile(url, outputPath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.get("/", (req, res) => {
  res.send("VideoShow API funcionando");
});

app.post("/create-video", async (req, res) => {
  try {
    const { images, audioUrl, secondsPerImage = 5 } = req.body;

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "Falta el array images" });
    }

    if (!audioUrl) {
      return res.status(400).json({ error: "Falta audioUrl" });
    }

    const workDir = path.join(__dirname, "tmp", Date.now().toString());
    fs.mkdirSync(workDir, { recursive: true });

    const localImages = [];
    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(workDir, `image_${i}.jpg`);
      await downloadFile(images[i], imagePath);
      localImages.push({
        path: imagePath,
        loop: secondsPerImage,
      });
    }

    const audioPath = path.join(workDir, "audio.mp3");
    await downloadFile(audioUrl, audioPath);

    const outputPath = path.join(workDir, "video.mp4");

    const videoOptions = {
      fps: 25,
      transition: false,
      videoBitrate: 1024,
      videoCodec: "libx264",
      size: "1280x720",
      format: "mp4",
      pixelFormat: "yuv420p",
    };

    videoshow(localImages, videoOptions)
      .audio(audioPath)
      .save(outputPath)
      .on("start", (command) => {
        console.log("FFmpeg command:", command);
      })
      .on("error", (err) => {
        console.error("VideoShow error:", err);
        return res.status(500).json({ error: "Error creando el vídeo" });
      })
      .on("end", () => {
        res.sendFile(outputPath, (err) => {
          if (err) {
            console.error("Send file error:", err);
          }
        });
      });
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
