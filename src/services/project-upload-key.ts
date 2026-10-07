// Matches the object key and URL emitted by upload.service.generatePresignedUrl.
export function isProjectStorageKey(projectId: string, key: unknown): key is string {
  if (typeof key !== "string") return false;
  const escapedProject = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^projects/${escapedProject}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\\.[^/\\\\]+)?$`, "i");
  return keyPattern.test(key);
}

export function isProjectUploadKey(projectId: string, key: unknown, fileUrl: unknown): boolean {
  if (!isProjectStorageKey(projectId, key) || typeof fileUrl !== "string") return false;
  const bucket = process.env.AWS_S3_BUCKET || "anka-os-documents";
  const region = process.env.AWS_REGION || "ap-south-1";
  return fileUrl === `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
