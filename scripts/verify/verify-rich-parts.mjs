// 临时验证脚本（不提交）：直接 import 核心层的 normalizeParts，逐条对照 docs/富内容外链.md §2/§2.1。
// 用法：node --import ./tmp/pg-register.mjs tmp/verify-rich-parts.mjs
import { normalizeParts } from '../src/core/submit.mjs';
import { hydrateParts } from '../src/media.mjs';

let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(name);
    console.error(`  \u2717 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
};

console.log('\n[1] 合法：https 外链的 image/voice/video/file/html 都通过');
const okCases = [
  ['image(url)', [{ type: 'image', url: 'https://cdn.example.com/a.png', width: 640, height: 480, alt: '图', mime: 'image/png' }]],
  ['voice(url)', [{ type: 'voice', url: 'https://cdn.example.com/a.m4a', duration_ms: 3200, mime: 'audio/mp4' }]],
  ['video(url+poster_url)', [{ type: 'video', url: 'https://cdn.example.com/a.mp4', poster_url: 'https://cdn.example.com/a.jpg', duration_ms: 12000, width: 1920, height: 1080 }]],
  ['file(url+name+files)', [{ type: 'file', url: 'https://cdn.example.com/pack.zip', name: '素材包.zip', bytes: 102400, mime: 'application/zip', files: [{ name: 'a.png', bytes: 12 }, { name: 'b.m4a' }] }]],
  ['html(url+title+height)', [{ type: 'html', url: 'https://cdn.example.com/report.html', title: '周报', height: 480 }]],
  ['html(srcdoc)', [{ type: 'html', srcdoc: '<h1>hi</h1>', title: '内嵌', height: 320 }]],
  ['html(url+srcdoc → url 优先)', [{ type: 'html', url: 'https://cdn.example.com/r.html', srcdoc: '<b>ignored</b>' }]],
  ['text+sticker 仍然可用', [{ type: 'text', text: '看这个' }, { type: 'sticker', pack: 'cute', key: 'wave' }]],
  ['video(attachment_id 旧路径)', [{ type: 'video', attachment_id: 12, poster_attachment_id: 13 }]],
];
for (const [label, parts] of okCases) {
  const r = normalizeParts(parts);
  ok(label, r.ok === true && Array.isArray(r.parts) && r.parts.length === parts.length, JSON.stringify(r));
}
const htmlBoth = normalizeParts([{ type: 'html', url: 'https://cdn.example.com/r.html', srcdoc: '<b>ignored</b>' }]);
ok('html 同时给 url/srcdoc 时只留 url', htmlBoth.ok && htmlBoth.parts[0].url === 'https://cdn.example.com/r.html' && htmlBoth.parts[0].srcdoc === undefined, JSON.stringify(htmlBoth.parts?.[0]));
const previews = normalizeParts([{ type: 'file', url: 'https://cdn.example.com/p.zip', name: 'p.zip' }]);
ok('file 段保留 name/url', previews.ok && previews.parts[0].name === 'p.zip' && previews.parts[0].url === 'https://cdn.example.com/p.zip', JSON.stringify(previews.parts?.[0]));

console.log('\n[2] 非法：全部拒绝且 reason=invalid_schema');
const tooLongUrl = `https://example.com/${'a'.repeat(2048)}`;
const rejects = [
  ['javascript:alert(1)', [{ type: 'image', url: 'javascript:alert(1)' }]],
  ['http://x', [{ type: 'image', url: 'http://x' }]],
  ['data:text/html,...', [{ type: 'image', url: 'data:text/html,<b>x</b>' }]],
  ['file:///etc/passwd', [{ type: 'file', url: 'file:///etc/passwd', name: 'passwd' }]],
  ['超长 url（>2048）', [{ type: 'image', url: tooLongUrl }]],
  ['files 51 条', [{ type: 'file', url: 'https://example.com/p.zip', name: 'p.zip', files: Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.txt` })) }]],
  ['user:pass@', [{ type: 'image', url: 'https://u:p@example.com/a.png' }]],
  ['srcdoc 24577 字符', [{ type: 'html', srcdoc: 'x'.repeat(24577) }]],
  ['6 段（超过 5）', Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' }))],
  ['video 既无 url 也无 attachment_id', [{ type: 'video' }]],
  ['file 外链缺 name', [{ type: 'file', url: 'https://example.com/p.zip' }]],
  ['bytes 越界', [{ type: 'file', url: 'https://example.com/p.zip', name: 'p.zip', bytes: 2 ** 31 + 1 }]],
  ['duration_ms 越界', [{ type: 'voice', url: 'https://example.com/a.m4a', duration_ms: 3_600_001 }]],
  ['unknown type', [{ type: 'audio', url: 'https://example.com/a.m4a' }]],
];
for (const [label, parts] of rejects) {
  const r = normalizeParts(parts);
  ok(`${label} → 拒绝`, r.ok === false && r.reason === 'invalid_schema', JSON.stringify(r));
  console.log(`      reason=${r.reason} | ${r.message}`);
}

console.log('\n[3] hydrateParts 不改坏外链段（media.mjs 未改动，验证原样透传）');
{
  const input = [
    { type: 'image', url: 'https://cdn.example.com/a.png', width: 640, alt: '图' },
    { type: 'file', url: 'https://cdn.example.com/p.zip', name: 'p.zip', files: [{ name: 'a.png', bytes: 1 }] },
    { type: 'html', srcdoc: '<b>x</b>', title: '内嵌' },
    { type: 'video', url: 'https://cdn.example.com/a.mp4', poster_url: 'https://cdn.example.com/a.jpg' },
  ];
  const out = await hydrateParts(input);
  ok('外链段 hydration 后逐字段相等（不追加本站签名 url）', JSON.stringify(out) === JSON.stringify(input), JSON.stringify(out));
}

console.log(`\n============================================================`);
console.log(`normalizeParts 验证：${passed} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.error(`失败项：${failures.join('；')}`);
  process.exitCode = 1;
}
