import argparse
import json
import platform
import subprocess
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WORLD = ROOT / 'world'
parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:5199/')
parser.add_argument('--shots', type=Path, default=ROOT / 'tmp/futian-street')
args = parser.parse_args()
args.shots.mkdir(parents=True, exist_ok=True)
options = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import{chromiumLaunchOptions}from'./tools/chromium.mjs';console.log(JSON.stringify(chromiumLaunchOptions()))"], cwd=WORLD, text=True))
launch_args = [a for a in options['args'] if 'swiftshader' not in a]
if platform.system() == 'Windows':
    launch_args.append('--use-angle=d3d11')
results = []
report = {'viewport': [1920, 1080], 'checks': results, 'views': []}


def check(name, passed, detail=None):
    results.append({'name': name, 'passed': bool(passed), 'detail': detail})
    print(f"{'PASS' if passed else 'FAIL'} {name}: {detail}", flush=True)
    assert passed, name


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=options['executablePath'], args=launch_args)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        start = time.perf_counter()
        page.goto(args.url + '?scene=futian', wait_until='networkidle', timeout=60000)
        page.wait_for_function('window.__worldDebug && window.__interactDebug && __worldDebug.read().avatarCount === 1', timeout=60000)
        report['devReadyMs'] = round((time.perf_counter() - start) * 1000)
        page.wait_for_function("document.querySelector('canvas')?.getContext('webgl2')?.isContextLost() === false")
        gpu = page.evaluate("()=>{const gl=document.querySelector('canvas').getContext('webgl2');const e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}")
        report['gpu'] = gpu
        check('real GPU renderer, not software rasterization', not any(s in gpu.lower() for s in ['swiftshader', 'llvmpipe', 'software']), gpu)
        page.wait_for_timeout(1200)
        check('sample paving raises spawn correctly', abs(page.evaluate('__interactDebug.read().heroPos[1]') - .12) < .05)

        def photograph(name, yaw):
            page.evaluate('(yaw)=>__worldDebug.setYaw(yaw)', yaw)
            page.wait_for_timeout(500)
            sample = page.evaluate("async()=>{const dt=[];await new Promise(resolve=>{const start=performance.now();let last=start;function tick(now){dt.push(now-last);last=now;if(now-start>=2500)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)});const sorted=dt.slice(2).sort((a,b)=>a-b);return {fps:1000/(sorted.reduce((a,b)=>a+b,0)/sorted.length),p95:sorted[Math.floor(sorted.length*.95)],state:__worldDebug.read(),player:__interactDebug.read()}}")
            sample['name'] = name
            report['views'].append(sample)
            check(name + ' 1080p >=60fps', sample['fps'] >= 60, round(sample['fps'], 1))
            check(name + ' frame p95 <=25ms', sample['p95'] <= 25, round(sample['p95'], 2))
            page.screenshot(path=str(args.shots / (name + '.png')))

        photograph('01-entrance', 1.57079632679)
        page.evaluate('__worldDebug.setYaw(-Math.PI / 2)')
        page.keyboard.down('Shift'); page.keyboard.down('w')
        page.wait_for_function('__interactDebug.read().heroPos[0] >= -297', timeout=15000)
        page.keyboard.up('w'); page.keyboard.up('Shift')
        check('walked from entrance to street without teleport', page.evaluate('__interactDebug.read().heroPos[0]') >= -297)
        photograph('02-streetside', 0)
        page.evaluate('__worldDebug.setYaw(0)')
        page.keyboard.down('Shift'); page.keyboard.down('w')
        page.wait_for_function('__interactDebug.read().heroPos[2] <= 316', timeout=25000)
        page.keyboard.up('w'); page.keyboard.up('Shift')
        check('walked north to junction without crossing buildings', page.evaluate('__interactDebug.read().heroPos[2]') <= 316)
        photograph('03-junction', 1.05)
        pos = page.evaluate('__interactDebug.read().heroPos')
        page.keyboard.press('Space')
        page.wait_for_function('(y)=>__interactDebug.read().heroPos[1]>y+.4', arg=pos[1], timeout=3000)
        page.wait_for_function('(y)=>Math.abs(__interactDebug.read().heroPos[1]-y)<.05 && __worldDebug.physState().grounded', arg=pos[1], timeout=5000)
        check('jump lands back on sample paving', True)
        page.get_by_role('button', name='鸟瞰街区', exact=True).click(); page.wait_for_timeout(1000)
        page.screenshot(path=str(args.shots / '04-landmark-overview.png'))
        page.get_by_role('button', name='返回步行', exact=True).click(); page.wait_for_timeout(500)
        check('overview return preserves walked position', abs(page.evaluate('__interactDebug.read().heroPos[0]') - pos[0]) < .1)
        check('no browser runtime errors', not errors, errors)
    finally:
        report['pageErrors'] = errors
        (args.shots / 'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
print(f'{len(results)}/{len(results)} street checks passed')
