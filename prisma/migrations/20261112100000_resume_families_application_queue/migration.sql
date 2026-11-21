ALTER TABLE "Application" ADD COLUMN "queueSort" INTEGER;
ALTER TABLE "Application" ADD COLUMN "resumeFamily" TEXT NOT NULL DEFAULT 'general';
