// 验收：AI 侧不该被系统消息触发（whats_new 里 kind=system 且 may_reply=false；send_message 引用它被拒）
import { whatsNewFor } from '../../src/core/query.mjs';
import { submit } from '../../src/core/submit.mjs';
import { pool, closeDb } from '../../src/db.mjs';

const CONV = Number(process.env.CONV || 91);

const agent = await pool.query(
  `SELECT p.id, p.display_name FROM conversation_members cm
     JOIN principals p ON p.id = cm.principal_id
    WHERE cm.conversation_id = $1 AND p.type = 'agent' LIMIT 1`,
  [CONV],
);
if (!agent.rows[0]) {
  console.log('群里没有 AI，跳过');
  process.exit(0);
}
const agentId = Number(agent.rows[0].id);
console.log('agent =', agentId, agent.rows[0].display_name);

const { events } = await whatsNewFor({ id: agentId, type: 'agent' }, { sinceSeq: 0, limit: 200 });
const sys = events.filter((e) => e.kind === 'system');
const humans = events.filter((e) => e.kind !== 'system' && e.senderType === 'user');
console.log('events =', events.length, '| system =', sys.length, '| human =', humans.length);
console.log('system sample =', JSON.stringify(sys[sys.length - 1] || null));
console.log('human mayReply 样例 =', humans.slice(-3).map((e) => e.mayReply));

const target = sys[sys.length - 1];
let gate = null;
if (target) {
  gate = await submit(
    { type: 'send_message', conversation_id: CONV, body: '收到', reply_to_seq: target.seq, client_msg_id: `sysgate_${Date.now()}` },
    { id: agentId, type: 'agent', displayName: agent.rows[0].display_name, avatarHue: 200 },
  );
  console.log('AI 回复系统消息 ->', JSON.stringify(gate));
}

const ok =
  sys.length >= 1 &&
  sys.every((e) => e.mayReply === false) &&
  (!gate || (gate.accepted === false && gate.reason === 'gating_system_notice'));
console.log(ok ? 'AI GATING ON SYSTEM NOTICE PASS' : 'AI GATING ON SYSTEM NOTICE FAIL');
await closeDb();
process.exit(ok ? 0 : 1);
