import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import { pathToFileURL, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const form = await req.formData();

  const file = form.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("thumbnail must be a file");
  }
  const MAX_UPLOAD_SIZE = 10 << 20; // 10 as mb

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("uploaded file exceeds the max upload size of 20");
  }
  const mediaType = file.type;
  const extension = file.type.split("/"[1]);
  const fileName = `${videoId}.${extension}`;

  const filePath = path.join(cfg.assetsRoot, fileName);

  const bytes = await file.arrayBuffer();

  await Bun.write(filePath, bytes);

  const thumbnailURL = `/assets/${fileName}`


  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Video not found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("You do not own this video");
  }

  video.thumbnailURL = thumbnailURL;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
