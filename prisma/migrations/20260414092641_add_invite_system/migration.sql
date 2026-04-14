-- AlterTable
ALTER TABLE "users" ADD COLUMN     "department" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "user_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "department" TEXT,
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_email_key" ON "user_invites"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_token_key" ON "user_invites"("token");

-- AddForeignKey
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
