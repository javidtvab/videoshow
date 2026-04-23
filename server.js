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
          downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
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

      file.on("finish", () => {
        file.close(resolve);
      });

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
}

function detectTrailingSilenceStart(filePath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", filePath,
      "-af", "silencedetect=noise=-38dB:d=1.2",
      "-f", "null",
      "-"
    ]);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", () => {
      // Buscar todos los "silence_start"
      const matches = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)];
      const silenceStarts = matches.map((m) => parseFloat(m[1])).filter((n) => !isNaN(n));

      if (!silenceStarts.length) {
        return resolve(null);
      }

      // Nos interesa el último
      resolve(silenceStarts[silenceStarts.length - 1]);
    });

    ffmpeg.on("error", (err) => {
      reject(err);
    });
  });
}

function cutAudio(inputPath, outputPath, endSeconds) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-t", String(endSeconds),
      "-c:a", "mp3",
      outputPath
    ]);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || "Error recortando audio"));
      }
      resolve();
    });

    ffmpeg.on("error", (err) => {
      reject(err);
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

    const originalDuration = await getAudioDuration(audioPath);

    let audioForVideo = audioPath;
    let effectiveDuration = originalDuration;

    // Detectar si hay silencio grande al final
    const trailingSilenceStart = await detectTrailingSilenceStart(audioPath);

    if (
      trailingSilenceStart &&
      trailingSilenceStart > 1 &&
      originalDuration - trailingSilenceStart > 1.5
    ) {
      const trimmedAudioPath = path.join(workDir, "audio_trimmed.mp3");
      const cutPoint = Math.max(1, trailingSilenceStart + 0.15);

      await cutAudio(audioPath, trimmedAudioPath, cutPoint);

      const trimmedDuration = await getAudioDuration(trimmedAudioPath);

      // Solo usar el recortado si quedó razonable
      if (
        trimmedDuration > 1 &&
        trimmedDuration < originalDuration &&
        trimmedDuration > originalDuration * 0.5
      ) {
        audioForVideo = trimmedAudioPath;
        effectiveDuration = trimmedDuration;
      }
    }

    // Si no se manda secondsPerImage o viene 0, calcularlo automáticamente
    const safeDuration = Math.max(1, effectiveDuration - 0.2);

    if (!secondsPerImage || secondsPerImage <= 0) {
      secondsPerImage = safeDuration / localImagePaths.length;
    }

    const listPath = path.join(workDir, "list.txt");
    const outputPath = path.join(workDir, "video.mp4");

    let listContent = "";
    localImagePaths.forEach((imgPath) => {
      listContent += `file '${imgPath}'\n`;
      listContent += `duration ${Number(secondsPerImage)}\n`;
    });

    // Repetir la última imagen para que FFmpeg aplique bien su duración
    listContent += `file '${localImagePaths[localImagePaths.length - 1]}'\n`;

    fs.writeFileSync(listPath, listContent);

    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-i", audioForVideo,
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-r", "25",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      outputPath
    ];

    console.log("Original audio duration:", originalDuration);
    console.log("Trailing silence start:", trailingSilenceStart);
    console.log("Effective audio duration:", effectiveDuration);
    console.log("Seconds per image:", secondsPerImage);
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
