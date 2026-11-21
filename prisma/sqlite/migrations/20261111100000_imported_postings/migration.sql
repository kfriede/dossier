ALTER TABLE "Posting" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "Posting" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Posting" ADD COLUMN "requisitionId" TEXT;
ALTER TABLE "Posting" ADD COLUMN "reportedRetrievedAt" DATETIME;
ALTER TABLE "Posting" ADD COLUMN "reportedCheckedAt" DATETIME;
ALTER TABLE "Posting" ADD COLUMN "researchNotes" TEXT;

CREATE TABLE "ConnectorWriteReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ConnectorWriteReceipt_clientId_operation_idempotencyKey_key"
  ON "ConnectorWriteReceipt"("clientId", "operation", "idempotencyKey");
CREATE INDEX "ConnectorWriteReceipt_createdAt_idx" ON "ConnectorWriteReceipt"("createdAt");
CREATE INDEX "Posting_source_company_idx" ON "Posting"("source", "company");
