"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectType = detectType;
exports.generatePresignedUrl = generatePresignedUrl;
exports.deleteFromS3 = deleteFromS3;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const crypto_1 = require("crypto");
const s3 = new client_s3_1.S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});
const BUCKET = process.env.AWS_S3_BUCKET;
function detectType(mimetype) {
    if (mimetype.startsWith("image/"))
        return "image";
    if (mimetype === "application/pdf")
        return "doc";
    if (mimetype.includes("spreadsheet") || mimetype.includes("excel") || mimetype.includes("csv"))
        return "spreadsheet";
    if (mimetype.includes("presentation") || mimetype.includes("powerpoint"))
        return "design";
    if (mimetype.includes("javascript") || mimetype.includes("typescript") || mimetype.includes("text/plain"))
        return "code";
    return "doc";
}
async function generatePresignedUrl(projectId, filename, mimetype) {
    const ext = filename.includes(".") ? filename.split(".").pop() : "";
    const key = `projects/${projectId}/${(0, crypto_1.randomUUID)()}${ext ? `.${ext}` : ""}`;
    const command = new client_s3_1.PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: mimetype,
    });
    const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, command, { expiresIn: 300 }); // 5 min
    const fileUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com/${key}`;
    return { uploadUrl, fileUrl, key };
}
async function deleteFromS3(key) {
    await s3.send(new client_s3_1.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
//# sourceMappingURL=upload.service.js.map