ALTER TYPE "VersionCause" ADD VALUE 'BEFORE_PROPOSAL';
ALTER TYPE "VersionCause" ADD VALUE 'PROPOSED';

CREATE TYPE "DocumentProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'STALE');

CREATE TABLE "DocumentProposal" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "expectedDocumentRevision" TEXT NOT NULL,
  "expectedProfileRevision" TEXT NOT NULL,
  "proposedUnits" JSONB NOT NULL,
  "sourceContext" JSONB NOT NULL,
  "warnings" JSONB NOT NULL,
  "status" "DocumentProposalStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "DocumentProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentProposal_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentProposal_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DocumentProposal_applicationId_status_createdAt_idx"
  ON "DocumentProposal"("applicationId", "status", "createdAt");
