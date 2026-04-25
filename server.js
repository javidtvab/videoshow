const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    client
      .get(url, (response) => {
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

        file.on("finish", () => file.close(resolve));

        file.on("error", (err) => {
          file.close();
          fs.unlink(dest, () => reject(err));
        });
      })
      .on("error", (err) => {
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
      filePath,
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

function createVideoHandler({ width, height, label }) {
  return async (req, res) => {
    let workDir;

    try {
      const { audioUrl } = req.body;
      let images = req.body.images;
      let secondsPerImage = Number(req.body.secondsPerImage || 0);

      if (typeof images === "string") {
        try {
          images = JSON.parse(images);
        } catch {
          return res.status(400).json({
            error: "images no es JSON válido",
          });
        }
      }

      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({
          error: "images debe ser un array con URLs",
        });
      }

      if (!audioUrl) {
        return res.status(400).json({
          error: "Falta audioUrl",
        });
      }

      workDir = path.join(__dirname, "tmp", Date.now().toString());
      fs.mkdirSync(workDir, { recursive: true });

      const localImagePaths = [];

      for (let i = 0; i < images.length; i++) {
        const imagePath = path.join(workDir, `image_${i + 1}.png`);
        await downloadFile(images[i], imagePath);
        localImagePaths.push(imagePath);
      }

      const audioPath = path.join(workDir, "audio.mp3");
      await downloadFile(audioUrl, audioPath);

      const audioDuration = await getAudioDuration(audioPath);

      if (!secondsPerImage || secondsPerImage <= 0) {
        secondsPerImage = audioDuration / localImagePaths.length;
      }

      const listPath = path.join(workDir, "list.txt");
      const outputPath = path.join(workDir, "video.mp4");

      let listContent = "";

      for (const imgPath of localImagePaths) {
        listContent += `file '${imgPath}'\n`;
        listContent += `duration ${secondsPerImage}\n`;
      }

      listContent += `file '${localImagePaths[localImagePaths.length - 1]}'\n`;

      fs.writeFileSync(listPath, listContent);

      const args = [
        "-y",

        "-f", "concat",
        "-safe", "0",
        "-i", listPath,

        "-i", audioPath,

        "-t", String(audioDuration),

        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,

        "-r", "25",

        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p",

        "-c:a", "aac",
        "-b:a", "128k",

        "-movflags", "+faststart",

        outputPath,
      ];

      console.log(`[${label}] Image count:`, localImagePaths.length);
      console.log(`[${label}] Audio duration:`, audioDuration);
      console.log(`[${label}] Seconds per image:`, secondsPerImage);
      console.log(`[${label}] Output resolution:`, `${width}x${height}`);

      const ffmpeg = spawn("ffmpeg", args);

      let stderr = "";

      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", (code, signal) => {
        if (code !== 0) {
          console.error(`[${label}] FFmpeg failed`, signal);

          return res.status(500).json({
            error: "Error creando el vídeo con ffmpeg",
            code,
            signal,
            details: stderr.slice(-4000),
          });
        }

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

        res.sendFile(outputPath, () => {
          if (workDir) {
            fs.rmSync(workDir, {
              recursive: true,
              force: true,
            });
          }
        });
      });
    } catch (error) {
      console.error(`[${label}] Server error:`, error);

      if (workDir) {
        fs.rmSync(workDir, {
          recursive: true,
          force: true,
        });
      }

      res.status(500).json({
        error: "Error interno del servidor",
        details: error.message,
      });
    }
  };
}

app.get("/", (req, res) => {
  res.send("FFmpeg API funcionando");
});

app.post(
  "/create-video",
  createVideoHandler({
    width: 1280,
    height: 720,
    label: "VIDEO",
  })
);

app.post(
  "/create-short",
  createVideoHandler({
    width: 720,
    height: 1280,
    label: "SHORT",
  })
);

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
