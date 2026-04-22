const express = require("express");
const videoshow = require("./lib");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

console.log("VIDEOSHOW TYPE:", typeof videoshow);
console.log("VIDEOSHOW:", videoshow);

const app = express();
const upload = multer({ dest: "uploads/" });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("VideoShow API funcionando");
});

app.post("/create-video", upload.any(), async (req, res) => {
  try {
    const secondsPerImage = Number(req.body.secondsPerImage || 5);

    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ error: "No se han recibido archivos" });
    }

    const audioFile = req.files.find((file) => file.fieldname === "audio");

    if (!audioFile) {
      return res.status(400).json({
        error: "Falta el archivo de audio",
        receivedFields: req.files.map((f) => f.fieldname),
      });
    }

    const imageFiles = req.files
      .filter((file) => /^image_\d+$/.test(file.fieldname))
      .sort((a, b) => {
        const numA = Number(a.fieldname.replace("image_", ""));
        const numB = Number(b.fieldname.replace("image_", ""));
        return numA - numB;
      });

    if (imageFiles.length === 0) {
      return res.status(400).json({
        error: "No se han recibido imágenes",
        receivedFields: req.files.map((f) => f.fieldname),
      });
    }

    const workDir = path.join(__dirname, "tmp", Date.now().toString());
    fs.mkdirSync(workDir, { recursive: true });

    const localImages = imageFiles.map((file) => ({
      path: file.path,
      loop: secondsPerImage,
    }));

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

    const video = videoshow(localImages, videoOptions);

    console.log("VIDEO INSTANCE TYPE:", typeof video);
    console.log("VIDEO INSTANCE:", video);

    if (!video) {
      return res.status(500).json({ error: "videoshow() devolvió undefined" });
    }

    video
      .audio(audioFile.path)
      .save(outputPath)
      .on("start", (command) => {
        console.log("FFmpeg command:", command);
        console.log("Received fields:", req.files.map((f) => f.fieldname));
      })
      .on("error", (err) => {
        console.error("VideoShow error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error creando el vídeo" });
        }
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
