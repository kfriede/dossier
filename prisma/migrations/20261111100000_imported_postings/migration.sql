ALTER TYPE "PostingSource" ADD VALUE 'IMPORTED';

ALTER TABLE "Posting"
  ADD COLUMN "sourceKind" TEXT,
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "requisitionId" TEXT,
  ADD COLUMN "reportedRetrievedAt" TIMESTAMP(3),
  ADD COLUMN "reportedCheckedAt" TIMESTAMP(3),
  ADD COLUMN "researchNotes" TEXT;

CREATE INDEX "Posting_source_company_idx" ON "Posting"("source", "company");

CREATE TABLE "ConnectorWriteReceipt" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorWriteReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectorWriteReceipt_clientId_operation_idempotencyKey_key"
  ON "ConnectorWriteReceipt"("clientId", "operation", "idempotencyKey");
CREATE INDEX "ConnectorWriteReceipt_createdAt_idx" ON "ConnectorWriteReceipt"("createdAt");
