ALTER TABLE attempts ADD COLUMN verdict TEXT DEFAULT NULL
  CHECK(verdict IS NULL OR (verdict IN ('yes', 'no') AND status = 'complete'));
