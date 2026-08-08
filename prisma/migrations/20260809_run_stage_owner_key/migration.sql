DROP INDEX "RunStage_runKind_runId_stage_inputDigest_policyVersion_routeVersion_key";

CREATE UNIQUE INDEX "RunStage_userId_runKind_runId_stage_inputDigest_policyVersion_routeVersion_key"
  ON "RunStage"(
    "userId", "runKind", "runId", "stage", "inputDigest", "policyVersion", "routeVersion"
  );
