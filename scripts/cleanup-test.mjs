// 清理回归/冒烟测试账号产生的可见数据。
// - 删掉测试用户拥有的会话与说说（读模型层）
// - 把测试 principal 标记 hidden（events 仍然引用它们，不能物理删除）
// 用法：
//   DATABASE_URL=... node scripts/cleanup-test.mjs --dry   # 只预览，事务回滚，不写库
//   DATABASE_URL=... node scripts/cleanup-test.mjs         # 真正执行
import pg from 'pg';

const url = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
// 清理类脚本必须支持 --dry（AGENTS §3）：预览走同一个事务，最后 ROLLBACK。
const DRY = process.argv.includes('--dry');
if (DRY) console.log('[dry] 只预览：所有写操作会在事务里回滚，不会改库\n');

// 测试账号的显示名清单：新增回归脚本时把它的测试昵称加进来，否则清理会漏（数据留在库里）
const TEST_NAMES = [
  '验收A', '验收B', '验收AI', '冒烟A', '冒烟B', '冒烟助手',
  '搜索A', '搜索B', '搜索C',
  '搜索UI-A', '搜索UI-B1', '搜索UI-B2', '搜索UI-B3', '搜索UI-B4', '搜索UI-B5',
  '推送A', '推送B', '推送C', '推送UI-A', '推送UI-B',
  '在线A', '在线B', '在线C', '在线UI-A', '在线UI-B',
  '审核UI-A', '审核UI-B', '审核UI-C',
  // 新增模块安全评审（2026-11-15）回归：verify-security-review-fixes.mjs
  '安全评审H', '安全评审S', '安全评审X', '安全评审Y', '安全评审R',
  '安全AI-A', '安全AI-B', '安全AI-C', '安全AI-D', '安全AI-E',
  // 群公告实时帧回归（2026-11-19）：verify-group-announcement.mjs
  '公告群主', '公告成员', '公告路人',
  // 缩略图并发闸 / 邮箱验证回归（2026-11-19）：verify-thumb-gate.mjs、verify-email-verification.mjs
  '缩略闸A', '验证无信', '验证可选', '验证必填', '验证链接页', '生产验证A', '验证兜底', '站务工具A',
  'Schema守卫', '主人关灯AI', '退群群主', '退群成员', '退群路人',
  // 参考 Agent / schema / 文档守卫回归（2026-11-19）
  '文档守卫', '示例主人', '形状探针',
  // 媒体扫描门回归（2026-11-19）：verify-media-scan-gate.mjs 造「扫描门…」人 + 「扫描门AI…」AI
  '扫描门',
  // 群上下文快照回归（2026-11-19）：verify-context.mjs 造「上下文A…」人 + 「上下文AI…」AI + 「上下文路人…」
  '上下文A',
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (DRY) await client.query('BEGIN');
  const { rows: users } = await client.query(
    `SELECT principal_id FROM user_accounts WHERE email LIKE 't\\_%@test.dev' OR email IN ('alice@test.dev','bob@test.dev')`,
  );
  const { rows: named } = await client.query(
    // 回归脚本造的 AI 昵称带随机后缀（示例AIa1b2…），用前缀匹配才清得掉
    `SELECT id FROM principals
      WHERE display_name = ANY($1::text[])
         OR display_name LIKE ANY($2::text[])`,
    [TEST_NAMES, ['公告AI%', '文档AI%', '示例AI%', 'SchemaAI%', '缩略闸%', '扫描门%', '上下文%']],
  );
  // 测试 AI 也是测试产物：它们的私聊（c2c）owner 是 agent 自己，按人 id 过滤会漏掉
  const { rows: ownedAgents } = await client.query(
    'SELECT principal_id FROM agents WHERE owner_user_id = ANY($1::bigint[])',
    [[...new Set([...users.map((r) => Number(r.principal_id)), ...named.map((r) => Number(r.id))])]],
  );
  const ids = [...new Set([
    ...users.map((r) => Number(r.principal_id)),
    ...named.map((r) => Number(r.id)),
    ...ownedAgents.map((r) => Number(r.principal_id)),
  ])];
  if (!ids.length) {
    console.log('没有测试账号需要清理');
  } else {
    // 表情包可能被分享到测试群（sticker_packs.group_id → conversations.id）：
    // 先解绑再删会话，否则外键会拦住清理（真实踩到过）。
    await client.query(
      `UPDATE sticker_packs SET scope = 'private', group_id = NULL
        WHERE group_id IN (
          SELECT id FROM conversations
           WHERE owner_id = ANY($1::bigint[]) OR created_by = ANY($1::bigint[])
              OR title LIKE '冒烟群-%' OR title LIKE '验收群%' OR title LIKE '公告群%' OR title LIKE '示例群%' OR title LIKE '退群验证群%' OR title = '自由发言群' OR title LIKE '多端验证群%' OR title LIKE '头像渐变验证群%' OR title LIKE '安全区验证群%' OR title LIKE '系统消息行-%' OR title LIKE '探针%群' OR title LIKE '烟测群%' OR title LIKE '性能B-%' OR title LIKE '探索能力群%' OR title LIKE 'MCP互测群%' OR title LIKE '迷雾测试群%' OR title LIKE '护栏回归-%' OR title LIKE '站务自己的群%'
              OR title = '站务自己的群' OR title LIKE '护栏回归-%')`,
      [ids],
    );
    const conv = await client.query(
      `DELETE FROM conversations
        WHERE owner_id = ANY($1::bigint[]) OR created_by = ANY($1::bigint[])
           OR title LIKE '冒烟群-%' OR title LIKE '验收群%' OR title LIKE '公告群%' OR title LIKE '示例群%' OR title = '自由发言群' OR title LIKE '多端验证群%' OR title LIKE '头像渐变验证群%' OR title LIKE '安全区验证群%' OR title LIKE '系统消息行-%' OR title LIKE '探针%群' OR title LIKE '烟测群%' OR title LIKE '性能B-%' OR title LIKE '探索能力群%' OR title LIKE 'MCP互测群%' OR title LIKE '迷雾测试群%' OR title LIKE '护栏回归-%' OR title LIKE '站务自己的群%'
           -- 审核验证用的「站务自己的群」：owner 是真实站务账号，不能被上面的 id 过滤命中，按标题单独清
           OR title = '站务自己的群'
           -- 早期 verify-limits 留下的护栏群（测试产物，标题带前缀）
           OR title LIKE '护栏回归-%'`,
      [ids],
    );
    // 软删除 + 写 FeedDeleted 事件：物理删除会让 M1 重放把已删数据复活
    const doomed = await client.query(
      `SELECT id FROM feeds WHERE (author_id = ANY($1::bigint[]) OR body LIKE '验收说说%' OR body LIKE 'UI 自动化测试%') AND deleted_at IS NULL`,
      [ids],
    );
    for (const row of doomed.rows) {
      await client.query('UPDATE feeds SET deleted_at = now() WHERE id = $1', [row.id]);
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('feed', $1, 'FeedDeleted', 4, 'user', '{}'::jsonb)`,
        [row.id],
      );
    }
    const feed = { rowCount: doomed.rowCount };
    // 测试举报：验证脚本会真的写入 reports（接口只有真写库才能验）。不处理掉的话
    // 线上「审核 → 待处理」会挂着一堆测试举报，看起来像真有人在等处理。
    // 判定：举报人是测试账号 / 没有会话定位的旧格式 / 目标消息已经不存在（会话被清掉了）。
    // 只标 dismissed 不物理删：保留审计痕迹。
    const reports = await client.query(
      `UPDATE reports r
          SET status = 'dismissed', action = 'test_cleanup',
              action_note = '自动化测试产物（目标已清理）', handled_at = now()
        WHERE r.status = 'open'
          AND (
            r.reporter_id = ANY($1::bigint[])
            OR r.conversation_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM messages_meta mm
                            WHERE mm.conversation_id = r.conversation_id AND mm.seq = r.target_id)
          )
        RETURNING r.id`,
      [ids],
    );
    // 推送订阅是「设备级」配置，不随会话删：单独清，否则测试账号的假 endpoint 会一直留着
    const push = await client.query('DELETE FROM push_subscriptions WHERE principal_id = ANY($1::bigint[])', [ids]);
    // 邮箱验证令牌：随账号隐藏一起清掉（表里有 principal_id 外键，留着会让「重跑验证」读到旧令牌）
    const mailTok = await client.query('DELETE FROM email_verifications WHERE principal_id = ANY($1::bigint[])', [ids]);
    // 候补队列：只清测试域名的申请（真实申请要留着，那是站务的待办）
    const waitTok = await client.query("DELETE FROM signup_waitlist WHERE email LIKE '%@test.dev'");
    // hidden = false 才算「本次影响」；dry-run 重复跑时数字才是真实的增量
    const hide = await client.query('UPDATE principals SET hidden = true WHERE id = ANY($1::bigint[]) AND hidden = false', [ids]);
    console.log(
      `${DRY ? '[dry] 将清理' : '清理完成'}：会话 ${conv.rowCount}，说说 ${feed.rowCount}，` +
      `推送订阅 ${push.rowCount}，测试举报 ${reports.rowCount}，隐藏账号 ${hide.rowCount}`,
    );
  }
  if (DRY) await client.query('ROLLBACK');
  const { rows: stat } = await client.query(
    `SELECT (SELECT count(*) FROM conversations) AS conversations,
            (SELECT count(*) FROM feeds) AS feeds,
            (SELECT count(*) FROM messages) AS messages,
            (SELECT count(*) FROM principals WHERE hidden = false) AS visible_principals`,
  );
  console.log('当前：', JSON.stringify(stat[0]));
} finally {
  await client.end().catch(() => {});
}
