-- M4 举报：消息 / 说说 / 表情包 / 表情条目
CREATE TABLE IF NOT EXISTS reports (
  id          BIGSERIAL PRIMARY KEY,
  reporter_id BIGINT NOT NULL REFERENCES principals(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('message','feed','sticker_pack','sticker_item')),
  target_id   BIGINT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS reports_target_idx ON reports (target_type, target_id);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);

-- 同一目标被 3 个不同的人举报 → 表情包自动进入待审（不直接下架，留人工判断）
CREATE OR REPLACE FUNCTION qm_flag_reported_pack() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  IF NEW.target_type = 'sticker_pack' THEN
    SELECT count(DISTINCT reporter_id) INTO v_count
      FROM reports WHERE target_type='sticker_pack' AND target_id = NEW.target_id AND status='open';
    IF v_count >= 3 THEN
      UPDATE sticker_packs SET review_state='pending', updated_at=now()
       WHERE id = NEW.target_id AND review_state <> 'rejected';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reports_flag_pack ON reports;
CREATE TRIGGER reports_flag_pack AFTER INSERT ON reports
FOR EACH ROW EXECUTE FUNCTION qm_flag_reported_pack();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON reports TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON SEQUENCE reports_id_seq TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_flag_reported_pack() TO qqmini_app';
  END IF;
END $$;
