// 数据库只追加验证：events / invite_audit（P0-4）
//
// 验证目标（生产加固后必须全 PASS）：
//   1) events、invite_audit 的 owner = postgres（不是 qqmini_app）；
//   2) qqmini_app 对 events 只有 SELECT/INSERT，没有 UPDATE/DELETE/TRUNCATE/
//      TRIGGER/REFERENCES；对 invite_audit 只有 SELECT/INSERT；
//   3) 用真实 SQL 证明：SET ROLE qqmini_app 后
//        UPDATE events SET type=type WHERE false;  → SQLSTATE 42501
//        DELETE FROM events WHERE false;           → SQLSTATE 42501
//        UPDATE invite_audit ... WHERE false;      → SQLSTATE 42501
//      WHERE false 不会改任何行；即使权限意外过宽也不会破坏数据。
//   4) 所有会 UPDATE events 的 SECURITY DEFINER 函数 owner = postgres
//      （qm_apply_system_message 是重点：它回填 events.seq）；
//   5) append-only 触发器仍在、函数 owner 是 postgres（app 删不掉触发器）。
//
// 本机 PG 5434 没有 qqmini_app 角色 → SKIP 并 exit 0（这是预期，不是失败）。
// 演练时用临时库 + 临时角色跑同一脚本。
//
// 用法：
//   ADMIN_DATABASE_URL='postgres://postgres@127.0.0.1:5434/aio_harden_drill' \
//     node scripts/verify/verify-db-immutability.mjs
//   缺 ADMIN_DATABASE_URL 时回退本机 5434/aio（便于本机看 SKIP 路径）。
import pg from 'pg';

const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

function targetLabel(connectionString) {
  try {
    const u = new URL(connectionString);
    return `${u.hostname || '(local socket)'}${u.port ? ':' + u.port : ''}/${u.pathname.replace(/^\//, '') || '(default)'}`;
  } catch {
    return '(无法解析连接串，已隐藏)';
  }
}

async function expectDenied(client, sql, label) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE qqmini_app');
    try {
      await client.query(sql);
      await client.query('ROLLBACK');
      check(label, false, '语句居然执行成功——权限过宽');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      check(label, err.code === '42501', `SQLSTATE ${err.code}：${String(err.message).split('\n')[0]}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    check(label, false, `SET ROLE/事务失败：${err.message}`);
  }
}

const client = new pg.Client({ connectionString: DB_URL });
try {
  await client.connect();
  console.log(`目标库：${targetLabel(DB_URL)}`);

  const role = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app'")).rowCount > 0;
  if (!role) {
    skip('角色 qqmini_app 不存在', '本机演练库/未 bootstrap；生产加固后应存在并重跑本脚本');
    console.log('\nSKIP：没有 qqmini_app 角色，无法做权限断言（exit 0）');
    process.exitCode = 0;
  } else {
    const row = (await client.query(
      `SELECT
         (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('public.events')) AS events_owner,
         (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('public.invite_audit')) AS audit_owner,
         (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
            WHERE p.oid = to_regprocedure('public.qm_apply_system_message(bigint,bigint,bigint,text,text,bigint[])')) AS fn_owner,
         (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
            WHERE p.oid = to_regprocedure('public.qm_invite_audit_append_only()')) AS trigger_fn_owner,
         to_regclass('public.events') IS NOT NULL AS has_events,
         to_regclass('public.invite_audit') IS NOT NULL AS has_audit`,
    )).rows[0];

    check('public.events 存在', row.has_events === true);
    check('public.invite_audit 存在', row.has_audit === true);

    check('events owner = postgres', row.events_owner === 'postgres', `owner=${row.events_owner}`);
    check('invite_audit owner = postgres', row.audit_owner === 'postgres', `owner=${row.audit_owner}`);
    check('qm_apply_system_message owner = postgres', row.fn_owner === 'postgres', `owner=${row.fn_owner}`);
    check('qm_invite_audit_append_only owner = postgres', row.trigger_fn_owner === 'postgres', `owner=${row.trigger_fn_owner}`);

    const exec = (await client.query(
      `SELECT has_function_privilege(
         'qqmini_app',
         'public.qm_apply_system_message(bigint,bigint,bigint,text,text,bigint[])',
         'EXECUTE') AS app_can_execute`,
    )).rows[0];
    check('app 仍能 EXECUTE qm_apply_system_message（系统消息不因加固失效）',
      exec.app_can_execute === true);

    const p = (await client.query(
      `SELECT
         has_table_privilege('qqmini_app', 'public.events', 'SELECT') AS events_select,
         has_table_privilege('qqmini_app', 'public.events', 'INSERT') AS events_insert,
         has_table_privilege('qqmini_app', 'public.events', 'UPDATE') AS events_update,
         has_table_privilege('qqmini_app', 'public.events', 'DELETE') AS events_delete,
         has_table_privilege('qqmini_app', 'public.events', 'TRUNCATE') AS events_truncate,
         has_table_privilege('qqmini_app', 'public.events', 'TRIGGER') AS events_trigger,
         has_table_privilege('qqmini_app', 'public.events', 'REFERENCES') AS events_references,
         has_table_privilege('qqmini_app', 'public.invite_audit', 'SELECT') AS audit_select,
         has_table_privilege('qqmini_app', 'public.invite_audit', 'INSERT') AS audit_insert,
         has_table_privilege('qqmini_app', 'public.invite_audit', 'UPDATE') AS audit_update,
         has_table_privilege('qqmini_app', 'public.invite_audit', 'DELETE') AS audit_delete,
         has_sequence_privilege('qqmini_app', 'public.events_id_seq', 'USAGE') AS events_seq_usage,
         has_sequence_privilege('qqmini_app', 'public.events_id_seq', 'SELECT') AS events_seq_select`,
    )).rows[0];

    check('app 对 events 有 SELECT', p.events_select === true);
    check('app 对 events 有 INSERT', p.events_insert === true);
    check('app 对 events 无 UPDATE', p.events_update === false);
    check('app 对 events 无 DELETE', p.events_delete === false);
    check('app 对 events 无 TRUNCATE', p.events_truncate === false);
    check('app 对 events 无 TRIGGER', p.events_trigger === false);
    check('app 对 events 无 REFERENCES', p.events_references === false);
    check('app 对 events_id_seq 有 USAGE/SELECT（INSERT 才能取 nextval）',
      p.events_seq_usage === true && p.events_seq_select === true);

    const evSeq = (await client.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c WHERE c.oid = 'public.events_id_seq'::regclass`,
    )).rows[0];
    check('events_id_seq owner = postgres', evSeq?.owner === 'postgres', `owner=${evSeq?.owner}`);

    if (row.has_audit) {
      const auditSeqName = (await client.query("SELECT pg_get_serial_sequence('public.invite_audit','id') AS seq")).rows[0]?.seq;
      if (auditSeqName) {
        const as = (await client.query(
          `SELECT pg_get_userbyid(c.relowner) AS owner,
                  has_sequence_privilege('qqmini_app', $1, 'USAGE') AS usage,
                  has_sequence_privilege('qqmini_app', $1, 'SELECT') AS sel
             FROM pg_class c WHERE c.oid = $1::regclass`,
          [auditSeqName],
        )).rows[0];
        check('invite_audit identity 序列 owner = postgres', as?.owner === 'postgres', `owner=${as?.owner} (${auditSeqName})`);
        check('app 对 invite_audit 序列有 USAGE/SELECT（INSERT 才能自增）',
          as?.usage === true && as?.sel === true);
      } else {
        skip('invite_audit 没有 identity 序列', '可能不是 identity 主键；跳过');
      }
    }

    if (row.has_audit) {
      check('app 对 invite_audit 有 SELECT', p.audit_select === true);
      check('app 对 invite_audit 有 INSERT', p.audit_insert === true);
      check('app 对 invite_audit 无 UPDATE', p.audit_update === false);
      check('app 对 invite_audit 无 DELETE', p.audit_delete === false);
    }

    // 动态兜底：任何 owner≠postgres 且源码 UPDATE events 的函数都不允许存在
    const badFns = (await client.query(
      `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND p.prosrc ~* 'update[[:space:]]+(public\\.)?events([[:space:]]|$)'
          AND pg_get_userbyid(p.proowner) <> 'postgres'
        ORDER BY 1`,
    )).rows;
    check('没有 owner≠postgres 的 UPDATE events 函数', badFns.length === 0,
      badFns.map((f) => `${f.sig}(owner=${f.owner})`).join(', ') || '0 个');

    const fnExec = (await client.query(
      `SELECT p.oid::regprocedure::text AS sig,
              has_function_privilege('qqmini_app', p.oid, 'EXECUTE') AS ok
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND p.prosrc ~* 'update[[:space:]]+(public\\.)?events([[:space:]]|$)'
        ORDER BY 1`,
    )).rows;
    const noExec = fnExec.filter((r) => r.ok !== true);
    check('所有 UPDATE events 函数 app 均可 EXECUTE（系统消息/投影不会因加固失效）',
      noExec.length === 0, noExec.map((r) => r.sig).join(', ') || `${fnExec.length} 个函数全部可执行`);

    // append-only 触发器存在且启用
    const trg = (await client.query(
      `SELECT t.tgenabled, p.proname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE c.oid = to_regclass('public.invite_audit')
          AND t.tgname = 'invite_audit_append_only' AND NOT t.tgisinternal`,
    )).rows[0];
    check('invite_audit 的 append-only 触发器存在且启用', Boolean(trg) && trg.tgenabled !== 'D',
      trg ? `tgenabled=${trg.tgenabled}` : '触发器不存在');

    // 真·权限测试：WHERE false 不改数据；权限过宽时也只是“执行成功”，不会污染库
    await expectDenied(client, 'UPDATE events SET type = type WHERE false', 'SET ROLE qqmini_app 后 UPDATE events 被 42501 拒绝');
    await expectDenied(client, 'DELETE FROM events WHERE false', 'SET ROLE qqmini_app 后 DELETE events 被 42501 拒绝');
    if (row.has_audit) {
      await expectDenied(client, "UPDATE invite_audit SET action = action WHERE false", 'SET ROLE qqmini_app 后 UPDATE invite_audit 被 42501 拒绝');
      await expectDenied(client, 'DELETE FROM invite_audit WHERE false', 'SET ROLE qqmini_app 后 DELETE invite_audit 被 42501 拒绝');
    }

    // [C4] mcp_writer 的授权不能被这次加固误伤/误放（存在才检查）
    const writer = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer'")).rowCount > 0;
    if (writer) {
      const w = (await client.query(
        `SELECT has_table_privilege('mcp_writer', 'public.events', 'SELECT') AS sel,
                has_table_privilege('mcp_writer', 'public.events', 'INSERT') AS ins,
                has_table_privilege('mcp_writer', 'public.events', 'UPDATE') AS upd,
                has_table_privilege('mcp_writer', 'public.events', 'DELETE') AS del`,
      )).rows[0];
      check('mcp_writer: events 仍有 SELECT/INSERT', w.sel === true && w.ins === true, `SELECT=${w.sel} INSERT=${w.ins}`);
      check('mcp_writer: events 无 UPDATE/DELETE（保持 [C4]）', w.upd === false && w.del === false, `UPDATE=${w.upd} DELETE=${w.del}`);
    } else {
      skip('mcp_writer 角色不存在', '本机演练库可忽略');
    }
  }
} catch (err) {
  check('脚本执行', false, err.message);
} finally {
  await client.end().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
