-- 安全加固：举报自动下架只作用于"有主的包"，且必须真的能看到这个包才能举报。
-- 原实现里 3 个新注册小号就能把官方表情包打成 pending（全站不可见），且只能 CLI 恢复。

CREATE OR REPLACE FUNCTION qm_flag_reported_pack() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_owner bigint;
  v_scope text;
BEGIN
  IF NEW.target_type = 'sticker_pack' THEN
    SELECT owner_id, scope INTO v_owner, v_scope FROM sticker_packs WHERE id = NEW.target_id;
    -- 官方包 / 公共包不参与自动下架（要人工处理），也不允许被"举报到下架"
    IF v_scope IN ('official', 'public') OR v_owner IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT count(DISTINCT reporter_id) INTO v_count
      FROM reports WHERE target_type='sticker_pack' AND target_id = NEW.target_id AND status='open';
    IF v_count >= 3 THEN
      UPDATE sticker_packs SET review_state='pending', updated_at=now()
       WHERE id = NEW.target_id AND review_state <> 'rejected' AND owner_id IS NOT NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
