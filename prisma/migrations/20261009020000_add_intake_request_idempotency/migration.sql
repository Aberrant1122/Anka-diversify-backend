CREATE TABLE "project_intake_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "response" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_intake_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_intake_requests_projectId_requestKey_key"
ON "project_intake_requests"("projectId", "requestKey");
CREATE INDEX "project_intake_requests_projectId_status_idx"
ON "project_intake_requests"("projectId", "status");
CREATE INDEX "project_intake_requests_sessionId_idx"
ON "project_intake_requests"("sessionId");

ALTER TABLE "project_intake_requests"
ADD CONSTRAINT "project_intake_requests_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_intake_requests"
ADD CONSTRAINT "project_intake_requests_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "ai_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
