"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadToCloudinary = uploadToCloudinary;
const cloudinary_1 = require("cloudinary");
const stream_1 = require("stream");
cloudinary_1.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
async function uploadToCloudinary(buffer, originalName, projectId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary_1.v2.uploader.upload_stream({
            folder: `anka-os/projects/${projectId}`,
            resource_type: "auto", // handles images, PDFs, docs
            public_id: `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.]/g, "_")}`,
        }, (error, result) => {
            if (error || !result)
                return reject(error || new Error("Upload failed"));
            const bytes = result.bytes;
            const size = bytes < 1024 ? `${bytes} B`
                : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
                    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            resolve({ url: result.secure_url, size, publicId: result.public_id });
        });
        stream_1.Readable.from(buffer).pipe(stream);
    });
}
//# sourceMappingURL=upload.service.js.map