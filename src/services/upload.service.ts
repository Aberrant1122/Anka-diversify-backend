import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function uploadToCloudinary(
  buffer: Buffer,
  originalName: string,
  projectId: string,
): Promise<{ url: string; size: string; publicId: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `anka-os/projects/${projectId}`,
        resource_type: "auto", // handles images, PDFs, docs
        public_id: `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.]/g, "_")}`,
      },
      (error, result) => {
        if (error || !result) return reject(error || new Error("Upload failed"));
        const bytes = result.bytes;
        const size =
          bytes < 1024 ? `${bytes} B`
          : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        resolve({ url: result.secure_url, size, publicId: result.public_id });
      },
    );
    Readable.from(buffer).pipe(stream);
  });
}
