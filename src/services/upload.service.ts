import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

// Validate S3 configuration
const validateS3Config = () => {
  const missing = [];
  if (!process.env.AWS_ACCESS_KEY_ID) missing.push("AWS_ACCESS_KEY_ID");
  if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push("AWS_SECRET_ACCESS_KEY");
  if (!process.env.AWS_S3_BUCKET && !process.env.AWS_S3_BUCKET_NAME) missing.push("AWS_S3_BUCKET");
  
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

const BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_S3_BUCKET_NAME || "anka-os-documents";

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

export async function generateDownloadUrl(key: string, expirationSeconds: number = 3600): Promise<string> {
  if (!isS3Configured) {
    throw new Error("S3 is not configured. Please check environment variables.");
  }

  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expirationSeconds });
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

/** Copy a browser-uploaded object to a key that is never issued by the presign API. */
export async function createEvidenceSnapshot(projectId: string, sourceKey: string): Promise<string> {
  if (!isS3Configured) throw new Error("S3 is not configured.");
  const snapshotKey = `projects/${projectId}/document-evidence/${randomUUID()}`;
  const copySource = `${BUCKET}/${sourceKey}`.split("/").map(encodeURIComponent).join("/");
  await s3.send(new CopyObjectCommand({
    Bucket: BUCKET,
    Key: snapshotKey,
    CopySource: copySource,
  }));
  return snapshotKey;
}

/**
 * Bounded read of an authorized S3 object.
 * Enforces a maximum byte limit (default 20MB) during streaming to avoid memory exhaustion.
 */
export async function fetchFromS3(
  key: string,
  maxBytes: number = 20 * 1024 * 1024
): Promise<{ buffer: Buffer; byteSize: number }> {
  if (!isS3Configured) {
    throw new Error("S3 is not configured. Please check environment variables.");
  }

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await s3.send(command);

    if (!response.Body) {
      throw new Error("Empty body received from S3");
    }

    const stream = response.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        if ("destroy" in stream && typeof (stream as any).destroy === "function") {
          (stream as any).destroy();
        }
        const err = new Error(`Document exceeds maximum size limit of ${maxBytes} bytes`);
        (err as any).code = "DOCUMENT_TOO_LARGE";
        throw err;
      }
      chunks.push(buf);
    }

    return { buffer: Buffer.concat(chunks), byteSize: totalBytes };
  } catch (error: any) {
    if (error.code === "DOCUMENT_TOO_LARGE") {
      throw error;
    }
    console.error("❌ Failed to fetch from S3:", error?.message || error);
    throw new Error(`Failed to fetch object from S3: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

export { s3, BUCKET, isS3Configured };
