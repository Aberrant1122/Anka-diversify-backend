-- CreateTable
CREATE TABLE "project_documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'note',
    "createdBy" TEXT NOT NULL DEFAULT 'AI Assistant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_documents_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
