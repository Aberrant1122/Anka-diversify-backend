import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutBucketEncryptionCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import type { BucketLocationConstraint } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const awsConfig = {
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
};

const bucketName = process.env.AWS_S3_BUCKET_NAME || "anka-os-documents";

async function setupS3() {
  try {
    if (!awsConfig.credentials.accessKeyId || !awsConfig.credentials.secretAccessKey) {
      throw new Error("AWS credentials not found in .env file");
    }

    const client = new S3Client(awsConfig);

    console.log(`🚀 Creating S3 bucket: ${bucketName} in region: ${awsConfig.region}`);

    // 1. Create bucket
    try {
      const createBucketInput: any = {
        Bucket: bucketName,
      };

      if (awsConfig.region !== "us-east-1") {
        createBucketInput.CreateBucketConfiguration = {
          LocationConstraint: awsConfig.region as BucketLocationConstraint,
        };
      }

      const createCommand = new CreateBucketCommand(createBucketInput);
      await client.send(createCommand);
      console.log("✅ Bucket created successfully");
    } catch (error: any) {
      if (error.name === "BucketAlreadyOwnedByYou") {
        console.log("✅ Bucket already exists");
      } else if (error.name === "BucketAlreadyExists") {
        throw new Error("Bucket name already exists globally on AWS. Choose a different name.");
      } else {
        throw error;
      }
    }

    // 2. Enable versioning
    const versionCommand = new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: "Enabled" },
    });
    await client.send(versionCommand);
    console.log("✅ Versioning enabled");

    // 3. Enable encryption
    const encryptCommand = new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: "AES256",
            },
          },
        ],
      },
    });
    await client.send(encryptCommand);
    console.log("✅ Server-side encryption enabled");

    // 4. Configure CORS for file uploads from frontend
    const corsCommand = new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ["*"],
            AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
            AllowedOrigins: [
              "http://localhost:3000",
              "http://localhost:3001",
              process.env.FRONTEND_URL || "*",
            ],
            ExposeHeaders: ["ETag", "x-amz-version-id"],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    });
    await client.send(corsCommand);
    console.log("✅ CORS configured");

    console.log("\n🎉 S3 bucket setup complete!");
    console.log(`📦 Bucket Name: ${bucketName}`);
    console.log(`🌍 Region: ${awsConfig.region}`);
    console.log("\nYou can now:");
    console.log("  • Upload files using the Files & Deliverables tab");
    console.log("  • Access files via presigned URLs");
    console.log("  • Store project documents securely");

  } catch (error) {
    console.error("❌ Error setting up S3 bucket:", error);
    process.exit(1);
  }
}

setupS3();
