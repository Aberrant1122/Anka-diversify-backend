const mockSend = jest.fn().mockResolvedValue({});
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CopyObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://mock-s3.local/signed-put"),
}));

describe("server-owned evidence snapshots", () => {
  const previous = {
    access: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    bucket: process.env.AWS_S3_BUCKET,
  };

  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_S3_BUCKET = "test-bucket";
  });

  afterAll(() => {
    if (previous.access === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previous.access;
    if (previous.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
    if (previous.bucket === undefined) delete process.env.AWS_S3_BUCKET;
    else process.env.AWS_S3_BUCKET = previous.bucket;
  });

  test("replayed presigned PUT targets the upload key, never the copied evidence key", async () => {
    const upload = require("../upload.service");
    const original = "projects/project-a/123e4567-e89b-42d3-a456-426614174000.pdf";
    const snapshot = await upload.createEvidenceSnapshot("project-a", original);
    expect(snapshot).toMatch(/^projects\/project-a\/document-evidence\/[0-9a-f-]+$/);
    expect(snapshot).not.toBe(original);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      input: { Bucket: "test-bucket", Key: snapshot, CopySource: `test-bucket/${original}` },
    }));

    const presigned = await upload.generatePresignedUrl("project-a", "replacement.pdf", "application/pdf");
    expect(presigned.key).toMatch(/^projects\/project-a\/[0-9a-f-]+\.pdf$/);
    expect(presigned.key).not.toBe(snapshot);
  });
});
