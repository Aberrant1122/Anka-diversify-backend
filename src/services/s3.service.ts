import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const bucketName = process.env.AWS_S3_BUCKET_NAME || "anka-os-documents";

export class S3Service {
  /**
   * Upload a file to S3
   * @param key - S3 object key (path), e.g., "projects/123/myfile.pdf"
   * @param buffer - File content as Buffer
   * @param contentType - MIME type
   * @returns S3 object key
   */
  static async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string = "application/octet-stream"
  ): Promise<{ key: string; url: string; size: number }> {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      });

      await s3Client.send(command);

      // Generate presigned URL (valid for 7 days)
      const url = await this.getPresignedUrl(key, 7 * 24 * 60 * 60);

      return {
        key,
        url,
        size: buffer.length,
      };
    } catch (error) {
      console.error("S3 upload error:", error);
      throw new Error(`Failed to upload file to S3: ${error}`);
    }
  }

  /**
   * Generate a presigned URL for downloading a file
   * @param key - S3 object key
   * @param expirationSeconds - URL expiration time in seconds (default: 1 hour)
   * @returns Presigned URL
   */
  static async getPresignedUrl(
    key: string,
    expirationSeconds: number = 3600
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      const url = await getSignedUrl(s3Client, command, {
        expiresIn: expirationSeconds,
      });

      return url;
    } catch (error) {
      console.error("Presigned URL generation error:", error);
      throw new Error(`Failed to generate presigned URL: ${error}`);
    }
  }

  /**
   * Delete a file from S3
   * @param key - S3 object key
   */
  static async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      await s3Client.send(command);
    } catch (error) {
      console.error("S3 delete error:", error);
      throw new Error(`Failed to delete file from S3: ${error}`);
    }
  }

  /**
   * Generate a safe S3 key from project and file info
   * @param projectId - Project ID
   * @param fileName - Original file name
   * @returns S3 key path
   */
  static generateKey(projectId: string, fileName: string): string {
    const timestamp = Date.now();
    const sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    return `projects/${projectId}/files/${timestamp}_${sanitized}`;
  }
}
