const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`Error descargando ${url}: ${response.statusCode}`));
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
    }).on("error", (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

app.get("/", (req, res) => {
  res.send("FFmpeg API funcionando");
});

app.post("/create-video", async (req, res) => {
  try {
const { audioUrl } = req.body;
let secondsPerImage = Number(req.body.secondsPerImage || 0);

let images = req.body.images;

if (typeof images === "string") {
  try {
    images = JSON.parse(images);
  } catch (e) {
    return res.status(400).json({ error: "images no es JSON válido" });
  }
}

if (!Array.isArray(images) || images.length === 0) {
  return res.status(400).json({ error: "images debe ser un array con URLs" });
}

    if (!audioUrl) {
      return res.status(400).json({ error: "Falta audioUrl" });
    }

    const workDir = path.join(__dirname, "tmp", Date.now().toString());
    fs.mkdirSync(workDir, { recursive: true });

    const localImagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(workDir, `image_${i + 1}.png`);
      await downloadFile(images[i], imagePath);
      localImagePaths.push(imagePath);
    }

    const audioPath = path.join(workDir, "audio.mp3");
    await downloadFile(audioUrl, audioPath);
    const getAudioDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    const probe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);

    let output = "";
    let error = "";

    probe.stdout.on("data", (data) => {
      output += data.toString();
    });

    probe.stderr.on("data", (data) => {
      error += data.toString();
    });

    probe.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(error || "ffprobe error"));
      }

      const duration = parseFloat(output.trim());

      if (!duration || isNaN(duration)) {
        return reject(new Error("No se pudo calcular la duración del audio"));
      }

      resolve(duration);
    });
  });
};

const trimAudioSilence = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-af", "silenceremove=start_periods=1:start_silence=0.3:start_threshold=-40dB:stop_periods=1:stop_silence=0.5:stop_threshold=-40dB",
      outputPath
    ]);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || "Error recortando silencios"));
      }
      resolve();
    });
  });
};
const trimmedAudioPath = path.join(workDir, "audio_trimmed.mp3");
await trimAudioSilence(audioPath, trimmedAudioPath);

const audioDuration = await getAudioDuration(trimmedAudioPath);

// Si no se manda secondsPerImage o viene 0, calcularlo automáticamente
if (!secondsPerImage || secondsPerImage <= 0) {
  secondsPerImage = audioDuration / localImagePaths.length;
}
    const listPath = path.join(workDir, "list.txt");
    const outputPath = path.join(workDir, "video.mp4");

    let listContent = "";
    localImagePaths.forEach((imgPath) => {
      listContent += `file '${imgPath}'\n`;
      listContent += `duration ${Number(secondsPerImage)}\n`;
    });
    listContent += `file '${localImagePaths[localImagePaths.length - 1]}'\n`;

    fs.writeFileSync(listPath, listContent);

    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-i", trimmedAudioPath,
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-r", "25",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      outputPath
    ];

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        return res.status(500).json({
          error: "Error creando el vídeo con ffmpeg",
          details: stderr
        });
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

      res.sendFile(outputPath);
    });

  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Error interno del servidor", details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
