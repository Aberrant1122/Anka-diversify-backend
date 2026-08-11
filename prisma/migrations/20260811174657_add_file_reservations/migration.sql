-- CreateTable
CREATE TABLE "file_reservations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "filePath" TEXT NOT NULL,
    "holderType" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_reservations_projectId_filePath_idx" ON "file_reservations"("projectId", "filePath");

-- AddForeignKey
ALTER TABLE "file_reservations" ADD CONSTRAINT "file_reservations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
