import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

// Validate S3 configuration
const validateS3Config = () => {
  const missing = [];
  if (!process.env.AWS_ACCESS_KEY_ID) missing.push("AWS_ACCESS_KEY_ID");
  if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push("AWS_SECRET_ACCESS_KEY");
  if (!process.env.AWS_S3_BUCKET_NAME) missing.push("AWS_S3_BUCKET_NAME");
  
  if (missing.length > 0) {
    console.error(`⚠️  Missing S3 environment variables: ${missing.join(", ")}`);
    return false;
  }
  
  console.log("✅ S3 configuration validated");
  return true;
};

const isS3Configured = validateS3Config();

const s3 = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET_NAME || "anka-os-documents";

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
  if (!isS3Configured) {
    throw new Error("S3 is not configured. Please check environment variables.");
  }

  const ext = filename.includes(".") ? filename.split(".").pop() : "";
  const key = `projects/${projectId}/${randomUUID()}${ext ? `.${ext}` : ""}`;

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: mimetype,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min
    const fileUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com/${key}`;

    console.log(`✅ Generated presigned URL for: ${filename}`);
    return { uploadUrl, fileUrl, key };
  } catch (error) {
    console.error("❌ Failed to generate presigned URL:", error);
    throw new Error(`Failed to generate S3 upload URL: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

export async function deleteFromS3(key: string): Promise<void> {
  if (!isS3Configured) {
    console.warn("⚠️  S3 not configured, skipping delete for:", key);
    return;
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log(`✅ Deleted from S3: ${key}`);
  } catch (error) {
    console.error("❌ Failed to delete from S3:", error);
    throw new Error(`Failed to delete from S3: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
