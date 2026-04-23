const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    client.get(url, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        file.close();
        fs.unlink(dest, () => {
          downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        });
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {
          reject(new Error(`Error descargando ${url}: ${response.statusCode}`));
        });
        return;
      }

      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", (err) => {
        file.close();
        fs.unlink(dest, () => reject(err));
      });
    }).on("error", (err) => {
      file.close();
      fs.unlink(dest, () => reject(err));
    });
  });
}

function getAudioDuration(filePath) {
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
      if (code !== 0) return reject(new Error(error || "ffprobe error"));
      const duration = parseFloat(output.trim());
      if (!duration || isNaN(duration)) {
        return reject(new Error("No se pudo calcular la duración del audio"));
      }
      resolve(duration);
    });
  });
}

// Convierte MP3 -> WAV y recorta SOLO silencio final
function convertAndTrimAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-af", "silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-45dB",
      "-ar", "44100",
      "-ac", "2",
      outputPath
    ]);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "Error recortando audio"));
      resolve();
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
      } catch {
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

    const audioMp3Path = path.join(workDir, "audio.mp3");
    await downloadFile(audioUrl, audioMp3Path);

    const audioWavPath = path.join(workDir, "audio_trimmed.wav");
    await convertAndTrimAudio(audioMp3Path, audioWavPath);

    const effectiveDuration = await getAudioDuration(audioWavPath);

    if (!secondsPerImage || secondsPerImage <= 0) {
      secondsPerImage = Math.max(1, effectiveDuration / localImagePaths.length);
    }

    const listPath = path.join(workDir, "list.txt");
    const outputPath = path.join(workDir, "video.mp4");

    let listContent = "";
    localImagePaths.forEach((imgPath) => {
      listContent += `file '${imgPath}'\n`;
      listContent += `duration ${secondsPerImage}\n`;
    });
    listContent += `file '${localImagePaths[localImagePaths.length - 1]}'\n`;

    fs.writeFileSync(listPath, listContent);

    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-i", audioWavPath,
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-r", "25",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      outputPath
    ];

    console.log("Effective audio duration:", effectiveDuration);
    console.log("Seconds per image:", secondsPerImage);

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
    res.status(500).json({
      error: "Error interno del servidor",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
