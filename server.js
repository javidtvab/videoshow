const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ dest: "uploads/" });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("FFmpeg API funcionando");
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

    const outputPath = path.join(workDir, "video.mp4");

    // Inputs FFmpeg
    const args = ["-y"];

    imageFiles.forEach((file) => {
      args.push("-loop", "1", "-t", String(secondsPerImage), "-i", file.path);
    });

    args.push("-i", audioFile.path);

    // Filtros de vídeo
    const videoFilters = imageFiles.map((_, index) => {
      return `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1[v${index}]`;
    });

    const concatInputs = imageFiles.map((_, index) => `[v${index}]`).join("");
    const filterComplex = [
      ...videoFilters,
      `${concatInputs}concat=n=${imageFiles.length}:v=1:a=0[v]`,
    ].join("; ");

    args.push(
      "-filter_complex", filterComplex,
      "-map", "[v]",
      "-map", `${imageFiles.length}:a`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      outputPath
    );

    console.log("FFmpeg args:", args);

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.error("FFmpeg error:", stderr);
        return res.status(500).json({
          error: "Error creando el vídeo con ffmpeg",
          details: stderr,
        });
      }

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
