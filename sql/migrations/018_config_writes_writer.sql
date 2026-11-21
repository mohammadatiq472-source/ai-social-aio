-- [评审 P2-6] AI 侧的「配置类写」不再用全权角色直接 UPDATE/INSERT 业务表。
--
-- 问题：setAvatarFor / createStickerPackFor / addStickerItemFor 走的是 qqmini_app（人类全权角色），
-- 与「AI 的一切写走 mcp_writer」的边界不一致。将来任何一处归属校验写错，攻击面就是全库 DML。
--
-- 做法：把这三类写收成三个窄口 SECURITY DEFINER 函数（限额/归属校验也在函数里），
-- mcp_writer 只拿 EXECUTE，不拿 sticker_packs / sticker_items / principals 的写权限。
--
-- 返回 jsonb：成功 {ok:true,...}，失败 {error:'too_many_packs'|'not_owned'|'too_many_items'|'duplicate_key', message}

CREATE OR REPLACE FUNCTION qm_set_principal_avatar(p_principal bigint, p_url text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  UPDATE principals
     SET avatar_url = NULLIF(btrim(p_url), ''),
         avatar_attachment_id = NULL
   WHERE id = p_principal;
END $fn$;

CREATE OR REPLACE FUNCTION qm_create_agent_sticker_pack(p_owner bigint, p_slug text, p_title text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_count int;
  v_row   sticker_packs;
BEGIN
  SELECT count(*)::int INTO v_count FROM sticker_packs WHERE owner_id = p_owner;
  IF v_count >= 20 THEN
    RETURN jsonb_build_object('error', 'too_many_packs', 'message', '每人最多 20 个表情包');
  END IF;
  INSERT INTO sticker_packs (slug, title, owner_id, scope, license)
  VALUES (p_slug, left(coalesce(p_title, ''), 20), p_owner, 'private', 'exclusive')
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'ok', true,
    'pack', jsonb_build_object(
      'id', v_row.id, 'slug', v_row.slug, 'title', v_row.title, 'scope', v_row.scope,
      'group_id', v_row.group_id, 'item_count', v_row.item_count, 'created_at', v_row.created_at
    )
  );
END $fn$;

CREATE OR REPLACE FUNCTION qm_add_agent_sticker_item(
  p_owner    bigint,
  p_pack     bigint,
  p_key      text,
  p_url      text,
  p_tags     text[],
  p_emotion  text,
  p_caption  text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_owner bigint;
  v_count int;
  v_id    bigint;
  v_key   text;
BEGIN
  SELECT owner_id INTO v_owner FROM sticker_packs WHERE id = p_pack;
  IF v_owner IS NULL OR v_owner <> p_owner THEN
    RETURN jsonb_build_object('error', 'not_owned', 'message', '只能往自己的表情包里加图');
  END IF;
  SELECT count(*)::int INTO v_count FROM sticker_items WHERE pack_id = p_pack;
  IF v_count >= 200 THEN
    RETURN jsonb_build_object('error', 'too_many_items', 'message', '每个包最多 200 张');
  END IF;
  v_key := coalesce(NULLIF(regexp_replace(coalesce(p_key, ''), '[^a-zA-Z0-9_-]', '', 'g'), ''), 'item' || (v_count + 1));
  v_key := left(v_key, 32);
  BEGIN
    INSERT INTO sticker_items (pack_id, key, static_path, tags, emotion, caption, sort)
    VALUES (p_pack, v_key, p_url, coalesce(p_tags, '{}'::text[]),
            NULLIF(left(coalesce(p_emotion, ''), 12), ''),
            left(coalesce(p_caption, ''), 40), v_count)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'duplicate_key', 'message', '这个 key 已经用过了');
  END;
  UPDATE sticker_packs
     SET item_count = (SELECT count(*) FROM sticker_items WHERE pack_id = p_pack),
         updated_at = now()
   WHERE id = p_pack;
  RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('item_id', v_id, 'key', v_key), 'item_count', v_count + 1);
END $fn$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_set_principal_avatar(bigint,text) TO mcp_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_create_agent_sticker_pack(bigint,text,text) TO mcp_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_add_agent_sticker_item(bigint,bigint,text,text,text[],text,text) TO mcp_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_set_principal_avatar(bigint,text) TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_create_agent_sticker_pack(bigint,text,text) TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_add_agent_sticker_item(bigint,bigint,text,text,text[],text,text) TO qqmini_app';
  END IF;
END $mig$;
