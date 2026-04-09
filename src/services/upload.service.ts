import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET!;

export function detectType(mimetype: string): string {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype === "application/pdf") return "doc";
  if (mimetype.includes("spreadsheet") || mimetype.includes("excel") || mimetype.includes("csv")) return "spreadsheet";
  if (mimetype.includes("presentation") || mimetype.includes("powerpoint")) return "design";
  if (mimetype.includes("javascript") || mimetype.includes("typescript") || mimetype.includes("text/plain")) return "code";
  return "doc";
}

export async function generatePresignedUrl(
  projectId: string,
  filename: string,
  mimetype: string,
): Promise<{ uploadUrl: string; fileUrl: string; key: string }> {
  const ext = filename.includes(".") ? filename.split(".").pop() : "";
  const key = `projects/${projectId}/${randomUUID()}${ext ? `.${ext}` : ""}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: mimetype,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min
  const fileUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com/${key}`;

  return { uploadUrl, fileUrl, key };
}

export async function deleteFromS3(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
