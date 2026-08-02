CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "DiscoveryItem_title_trgm_idx"
  ON "DiscoveryItem" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "DiscoveryItem_summary_trgm_idx"
  ON "DiscoveryItem" USING GIN ("summary" gin_trgm_ops);
CREATE INDEX "DiscoveryItem_reason_trgm_idx"
  ON "DiscoveryItem" USING GIN ("reason" gin_trgm_ops);

CREATE INDEX "RadarItem_title_trgm_idx"
  ON "RadarItem" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "RadarItem_summary_trgm_idx"
  ON "RadarItem" USING GIN ("summary" gin_trgm_ops);
CREATE INDEX "RadarItem_reason_trgm_idx"
  ON "RadarItem" USING GIN ("reason" gin_trgm_ops);
