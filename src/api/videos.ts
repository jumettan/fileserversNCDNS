import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { BadRequestError, UserForbiddenError } from "./errors";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {

  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Video was not found");
  }
  const token = await getBearerToken(req.headers);
  const userId = validateJWT(token, cfg.jwtSecret);

  const video = await getVideo(cfg.db, videoId);
  if (video?.userID !== userId) {
    throw new UserForbiddenError("User doenst match the uploader of the video");
  }

  const form = await req.formData();

  const file = form.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("thumbnail must be a file");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`File size exceeds the max allowed size of: ${MAX_UPLOAD_SIZE}`);
  }
  const allowedType = "video/mp4";
  if (file.type !== allowedType) {
    throw new BadRequestError(`file type doesnt macth the allowed tyoe of: ${allowedType}`);
  }
  const bytes = await file.arrayBuffer();

  const tempPath = `/tmp/${crypto.randomUUID()}.mp4`;

  await Bun.write(tempPath, bytes);
  const aspectRatio = await getVideoAspectRatio(tempPath);
  const processedVideoPath = await processVideoForFastStart(tempPath);
  const key = `${aspectRatio}/${videoId}.mp4`;
  try {
    const s3File = cfg.s3Client.file(key);
    const processedFile = Bun.file(processedVideoPath);
    await s3File.write(processedFile, {
      type: file.type || "video/mp4",
    });
  } finally {
    await Bun.file(tempPath).delete();
    await Bun.file(processedVideoPath).delete();
  }

  const distributionBaseURL = cfg.s3CfDistribution.replace(/\/+$/, "");
  video.videoURL = `${distributionBaseURL}/${key}`;
  await updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}


export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new BadRequestError(`ffprobe failed: ${stderrText}`);
  }

  const data = JSON.parse(stdoutText);
  const stream = data.streams?.[0];

  const width = stream.width;
  const height = stream.height;

  const ratio = width / height;

  const sixteenNine = 16 / 9;
  const nineSixteen = 9 / 16;

  if (Math.abs(ratio - sixteenNine) < 0.01) return "landscape";
  if (Math.abs(ratio - nineSixteen) < 0.01) return "portrait";

  return "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed.mp4`;

  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ]);

  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new BadRequestError(`ffmpeg failed: ${stderrText}`);
  }

  return outputFilePath;
}
