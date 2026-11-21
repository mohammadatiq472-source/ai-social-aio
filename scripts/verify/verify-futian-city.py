import argparse
import json
import math
import platform
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WORLD = ROOT / 'world'
parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:5199/')
parser.add_argument('--software', action='store_true', help='Use SwiftShader for functionality only, not GPU performance')
parser.add_argument('--shots', type=Path, default=ROOT / 'tmp/city-recon-20261121')
args = parser.parse_args()
args.shots.mkdir(parents=True, exist_ok=True)
launch = json.loads(subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {chromiumLaunchOptions} from './tools/chromium.mjs'; console.log(JSON.stringify(chromiumLaunchOptions()))",
], cwd=WORLD, text=True))
results = []


def check(name, value, detail=None):
    results.append({'name': name, 'ok': bool(value), 'detail': detail})
    print(f"{'PASS' if value else 'FAIL'} {name}: {detail}", flush=True)
    assert value, name


def state(page):
    return page.evaluate('({world:__worldDebug.read(),player:__interactDebug.read()})')


with sync_playwright() as p:
    launch_args = launch['args'] if args.software else [a for a in launch['args'] if 'swiftshader' not in a]
    if not args.software and platform.system() == 'Windows':
        launch_args.append('--use-angle=d3d11')
    browser = p.chromium.launch(headless=True, executable_path=launch['executablePath'], args=launch_args)
    page = browser.new_page(viewport={'width': 960, 'height': 640})
    errors = []
    city_requests = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: city_requests.append(request.url) if '/assets/city/' in request.url else None)
    try:
        page.goto(args.url + '?scene=futian', wait_until='networkidle', timeout=60000)
        page.wait_for_function('window.__worldDebug && window.__interactDebug && document.querySelector("#city-info")', timeout=90000)
        page.wait_for_function("document.querySelector('canvas')?.getContext('webgl2')?.isContextLost() === false", timeout=30000)
        page.wait_for_timeout(6000)
        s = state(page)
        check('city data fetched once', sum('/assets/city/futian.json' in url for url in city_requests) == 1, len(city_requests))
        buildings = [mesh for mesh in s['world']['scene']['meshes'] if mesh['name'].startswith('city-buildings-')]
        check('three facade styles stay within twelve building batches', 0 < len(buildings) <= 12 and all(any(style in mesh['name'] for mesh in buildings) for style in ['glass', 'office', 'stone']), len(buildings))
        paving_height = json.loads((WORLD / 'assets/city/futian.json').read_text(encoding='utf-8'))['spawn'][1]
        check('player grounded on sample paving', abs(s['player']['heroPos'][1] - paving_height) < 0.05, s['player']['heroPos'])
        check('street kit is rendered', any(mesh['name'] == 'city-street-kit' for mesh in s['world']['scene']['meshes']))
        material_state = page.evaluate("()=>{const s=__worldDebug.scene(),p=s.getObjectByName('city-paving').material,r=s.getObjectByName('city-roads');let g; s.traverse(o=>{if(!g&&o.name&&o.name.startsWith('city-buildings-glass-'))g=o}); const m=g.material;return {pbr:!!(p.map&&p.normalMap&&p.roughnessMap&&p.aoMap),spaces:[p.map.colorSpace,p.normalMap.colorSpace,p.roughnessMap.colorSpace],roadUV:!!r.geometry.getAttribute('uv'),probe:s.environment.name,explicit:m.envMap===s.environment,physical:m.isMeshPhysicalMaterial}}")
        check('PBR maps and linear data textures are connected', material_state['pbr'] and material_state['spaces'] == ['srgb', '', ''], material_state)
        check('road has meter-based texture coordinates', material_state['roadUV'])
        check('glass explicitly binds the captured street reflection', material_state['physical'] and material_state['explicit'] and material_state['probe'] == 'futian-local-reflection')
        check('height uncertainty and source labels visible', '模型估算' in page.locator('#city-info').inner_text())
        page.screenshot(path=str(args.shots / 'futian-walk.png'))
        reopen = page.locator('#city-info-reopen')
        if reopen.count() and reopen.is_visible():
            reopen.click()
            page.wait_for_timeout(350)
        page.get_by_role('button', name='鸟瞰街区', exact=True).click()
        page.wait_for_function('__worldDebug.scene().getObjectByName("futian-city") && document.querySelector("#city-info button[aria-pressed]").getAttribute("aria-pressed") === "true"')
        page.wait_for_timeout(2500)
        page.screenshot(path=str(args.shots / 'futian-overview.png'))
        check('overview enabled', page.get_by_role('button', name='返回步行', exact=True).get_attribute('aria-pressed') == 'true')
        page.locator('#fly-exit').click()
        page.wait_for_timeout(1000)
        after_view = state(page)
        check('overview does not teleport player', math.dist(s['player']['heroPos'], after_view['player']['heroPos']) < 0.05)
        page.evaluate('__worldDebug.setYaw(Math.PI / 2)')
        s = state(page)
        start = s['player']['heroPos']
        wall = page.evaluate('p => __worldDebug.raycast([p[0],1,p[2]],[p[0]-50,1,p[2]])', start)
        check('landmark wall ray is within walking range', wall is not None and 2 < wall < 40, wall)
        page.keyboard.down('Shift')
        page.keyboard.down('w')
        page.wait_for_function('(p) => __interactDebug.read().heroPos[0] < p.x - p.distance + 0.8', arg={'x': start[0], 'distance': wall}, timeout=180000)
        reached = state(page)
        page.wait_for_function('(tick) => __worldDebug.read().physicsSteps >= tick + 30', arg=reached['world']['physicsSteps'], timeout=90000)
        blocked = state(page)
        check('real keyboard movement reaches wall', start[0] - blocked['player']['heroPos'][0] > wall - 1, blocked['player']['heroPos'])
        check('sprinting does not cross visible wall', blocked['player']['heroPos'][0] > start[0] - wall + 0.2)
        check('pushing into wall remains stable', abs(blocked['player']['heroPos'][0] - reached['player']['heroPos'][0]) < 0.5)
        check('wall contact does not sink player into floor', abs(blocked['player']['heroPos'][1]) < 0.05, blocked['player']['heroPos'][1])
        page.keyboard.up('Shift')
        page.keyboard.down('d')
        tick = blocked['world']['physicsSteps']
        page.wait_for_function('(tick) => __worldDebug.read().physicsSteps >= tick + 30', arg=tick, timeout=90000)
        page.keyboard.up('w')
        page.keyboard.up('d')
        slid = state(page)
        check('strafe slides along wall', abs(slid['player']['heroPos'][2] - blocked['player']['heroPos'][2]) > 0.4, slid['player']['heroPos'])
        check('wall sliding keeps feet above ground', abs(slid['player']['heroPos'][1]) < 0.05, slid['player']['heroPos'][1])
        environment_before = page.evaluate('__worldDebug.scene().environment.uuid')
        textures_before = state(page)['world']['textures']
        page.evaluate('__worldDebug.setTimeImmediate("night")')
        page.wait_for_function('(id)=>__worldDebug.scene().environment.uuid!==id', arg=environment_before, timeout=30000)
        environment_night = page.evaluate('__worldDebug.scene().environment.uuid')
        page.evaluate('__worldDebug.setTime("day")')
        page.wait_for_function('__worldDebug.lightingState().target === null', timeout=60000)
        fog = page.evaluate('({near:__worldDebug.scene().fog.near,far:__worldDebug.scene().fog.far})')
        check('lighting transitions preserve city fog scale', 1000 <= fog['near'] < fog['far'] <= 7000, fog)
        page.wait_for_function('(id)=>__worldDebug.scene().environment.uuid!==id', arg=environment_night, timeout=30000)
        check('reflection bindings refresh after lighting changes', page.evaluate("()=>{const s=__worldDebug.scene();let g; s.traverse(o=>{if(!g&&o.name&&o.name.startsWith('city-buildings-glass-'))g=o}); return g.material.envMap===s.environment}"))
        check('reflection replacement does not accumulate textures', state(page)['world']['textures'] <= textures_before + 2)
        check('no browser runtime errors', not errors, errors)
        before = len(city_requests)
        page.get_by_role('link', name='原房间', exact=True).click()
        page.wait_for_function('window.__interactDebug && window.__worldDebug && __worldDebug.read().physicsSteps > 10', timeout=90000)
        default = state(page)
        check('returning restores original room', not page.locator('#city-info').count() and len(default['player']['seats']) == 2)
        check('default room does not fetch city asset', len(city_requests) == before)
        broken = browser.new_page(viewport={'width': 800, 'height': 600})
        broken.route('**/assets/city/futian.json', lambda route: route.fulfill(status=503, body='unavailable'))
        broken.goto(args.url + '?scene=futian', wait_until='networkidle')
        broken.wait_for_selector('#boot-error[data-visible="true"]')
        check('data load failure is visible, not a collisionless city', '503' in broken.locator('#boot-error-msg').inner_text() and not broken.locator('#city-info').count())
        broken.close()
        missing_map = browser.new_page()
        missing_map.route('**/materials/granite-color.webp', lambda route: route.fulfill(status=404, body='missing'))
        missing_map.goto(args.url + '?scene=futian', wait_until='networkidle')
        missing_map.wait_for_selector('#boot-error[data-visible="true"]')
        check('missing PBR map produces visible failure instead of a silent fallback', 'PBR' in missing_map.locator('#boot-error-msg').inner_text() and not missing_map.locator('#city-info').count())
        missing_map.close()
    finally:
        (args.shots / 'futian-browser-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
print(f'{len(results)}/{len(results)} browser checks passed')
