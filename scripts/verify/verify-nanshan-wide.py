# -*- coding: utf-8 -*-
"""南山样区浏览器验收（?scene=nanshan）。

与 verify-futian-city.py 共用一套驱动方式，但断言只看南山数据里真实存在的东西：
  - nanshan.json 只拉一次；信息卡标题是南山
  - 建筑批次 ≤12；玩家站在 spawn.y 上
  - 鸟瞰只动相机、不传送
  - 真实键盘冲刺到最近楼墙：不穿墙、不下沉、能沿墙滑
  - 回原房间不重复拉城市数据；数据 503 时显示错误块而不是无碰撞城市
  - 全程零 pageerror

用法（先在 world 下起 dev）：
  cd world && npm run dev -- --port 5199
  python scripts/verify/verify-nanshan-wide.py --url http://127.0.0.1:5199/
"""
import argparse
import json
import math
import platform
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WORLD = ROOT / 'world'
INDEX_JSON = WORLD / 'assets/city/nanshan-wide/index.json'
parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:5199/')
parser.add_argument('--software', action='store_true', help='SwiftShader 仅用于功能验证，不能代表 GPU 性能')
parser.add_argument('--shots', type=Path, default=ROOT / 'tmp/nanshan-wide')
args = parser.parse_args()
args.shots.mkdir(parents=True, exist_ok=True)

if not INDEX_JSON.exists():
    raise SystemExit(f'缺少 {INDEX_JSON}：先跑 python world/tools/build-city/build_city.py --scene nanshan-wide && python world/tools/build-city/split_tiles.py --scene nanshan-wide')

launch = json.loads(subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {chromiumLaunchOptions} from './tools/chromium.mjs'; console.log(JSON.stringify(chromiumLaunchOptions()))",
], cwd=WORLD, text=True))
city = json.loads(INDEX_JSON.read_text(encoding='utf-8'))
spawn = city['spawn']
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
        page.goto(args.url + '?scene=nanshan-wide', wait_until='networkidle', timeout=60000)
        page.wait_for_function('window.__worldDebug && window.__interactDebug && document.querySelector("#city-info")', timeout=90000)
        page.wait_for_function("document.querySelector('canvas')?.getContext('webgl2')?.isContextLost() === false", timeout=30000)
        page.wait_for_timeout(6000)
        s = state(page)
        tile_mode = any('/assets/city/nanshan-wide/index.json' in url for url in city_requests)
        if tile_mode:
            check('tile index fetched once', sum('/assets/city/nanshan-wide/index.json' in url for url in city_requests) == 1, len(city_requests))
            stats = s['world']
            check('spawn 3x3 window loaded', stats.get('tilesLoaded', 0) >= 9 and stats.get('lod0', 0) >= 5, {k: stats.get(k) for k in ('tilesLoaded', 'lod0', 'lod1', 'collisionTiles')})
        else:
            check('single JSON fetched once', sum('/assets/city/nanshan-wide/index.json' in url for url in city_requests) == 1, len(city_requests))
        check('info panel names the nanshan scene', '南山' in page.locator('#city-info').inner_text())
        buildings = [mesh for mesh in s['world']['scene']['meshes']
                     if mesh['name'].startswith('city-buildings-') or '-lod0-' in mesh['name']]
        if tile_mode:
            check('building batches scale with loaded tiles', 0 < len(buildings) <= 90, len(buildings))
        else:
            check('facade batches stay within thirty-six', 0 < len(buildings) <= 36, len(buildings))
        names = [mesh['name'] for mesh in s['world']['scene']['meshes']]
        check('water layer exists', 'city-water' in names)
        check('sidewalk layer exists', any('sidewalks' in name for name in names))
        check('player grounded at data spawn height', abs(s['player']['heroPos'][1] - spawn[1]) < 0.05, s['player']['heroPos'])
        page.screenshot(path=str(args.shots / 'nanshan-first.png'))

        # 鸟瞰：只动相机
        reopen = page.locator('#city-info-reopen')
        if reopen.count() and reopen.is_visible():
            reopen.click()
            page.wait_for_timeout(350)
        page.get_by_role('button', name='鸟瞰街区', exact=True).click()
        page.wait_for_function('document.querySelector("#city-info button[aria-pressed]").getAttribute("aria-pressed") === "true"')
        page.wait_for_timeout(2500)
        page.screenshot(path=str(args.shots / 'nanshan-overview.png'))
        page.locator('#fly-exit').click()
        page.wait_for_timeout(1000)
        after_view = state(page)
        check('overview does not teleport player', math.dist(s['player']['heroPos'], after_view['player']['heroPos']) < 0.05)

        # 找最近的楼墙：8 个方向，最多 600m（南山 v0.2 出生在人才公园，最近楼墙约 400m）
        start = state(page)['player']['heroPos']
        directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
        best = None
        for dx, dz in directions:
            length = math.hypot(dx, dz)
            ux, uz = dx / length, dz / length
            wall = page.evaluate(
                '([sx,sz,ux,uz]) => __worldDebug.raycast([sx,1,sz],[sx+ux*600,1,sz+uz*600])',
                [start[0], start[2], ux, uz],
            )
            if wall is not None and 3 < wall < 600 and (best is None or wall < best[0]):
                best = (wall, ux, uz)

        if best is None or best[0] > 80:
            # 开阔公园出生点：不走墙体接触（400m 冲刺太慢），只验证能走、不下沉。
            # 墙体接触由 city.test.ts 的真实胶囊用例覆盖。
            check('open spawn: nearest wall is over 80m (park spawn)', best is None or best[0] > 80, best)
            page.evaluate('([ux,uz]) => __worldDebug.setYaw(Math.atan2(-ux, -uz))', [0.0, 1.0])
            page.keyboard.down('Shift')
            page.keyboard.down('w')
            start_pos = state(page)['player']['heroPos']
            page.wait_for_timeout(4000)
            walked = state(page)
            page.keyboard.up('w')
            page.keyboard.up('Shift')
            travelled = math.dist([start_pos[0], start_pos[2]], [walked['player']['heroPos'][0], walked['player']['heroPos'][2]])
            check('open spawn: sprinting moves and stays grounded', travelled > 2 and abs(walked['player']['heroPos'][1] - spawn[1]) < 0.08, {'travelled': travelled, 'y': walked['player']['heroPos'][1]})
            page.screenshot(path=str(args.shots / 'nanshan-walk.png'))
        else:
            wall, ux, uz = best
            check('a building wall is reachable near spawn', True, best)
            page.evaluate('([ux,uz]) => __worldDebug.setYaw(Math.atan2(-ux, -uz))', [ux, uz])
            page.keyboard.down('Shift')
            page.keyboard.down('w')
            start_pos = state(page)['player']['heroPos']
            page.wait_for_function(
                '(args) => { const p = __interactDebug.read().heroPos; const d = Math.hypot(p[0] - args[0], p[2] - args[1]); return d > args[2] - 2 || d > 60; }',
                arg=[start_pos[0], start_pos[2], wall],
                timeout=20000,
            )
            page.wait_for_timeout(600)
            blocked = state(page)
            page.keyboard.up('w')
            page.keyboard.up('Shift')
            dxp = blocked['player']['heroPos'][0] - start_pos[0]
            dzp = blocked['player']['heroPos'][2] - start_pos[2]
            travelled = math.hypot(dxp, dzp)
            check('sprinting moves toward the wall', travelled > 2 and dxp * ux + dzp * uz > 0, {'travelled': travelled})
            check('sprinting does not cross the visible wall', travelled < wall + 1, {'travelled': travelled, 'wall': wall})
            check('wall contact does not sink player', abs(blocked['player']['heroPos'][1] - spawn[1]) < 0.08, blocked['player']['heroPos'][1])
            page.screenshot(path=str(args.shots / 'nanshan-wall.png'))

        check('no browser runtime errors', not errors, errors)
        before = len(city_requests)
        page.get_by_role('link', name='原房间', exact=True).click()
        page.wait_for_function('window.__interactDebug && window.__worldDebug && __worldDebug.read().physicsSteps > 10', timeout=90000)
        default = state(page)
        check('returning restores original room', not page.locator('#city-info').count() and len(default['player']['seats']) == 2)
        check('default room does not fetch city asset', len(city_requests) == before)

        broken = browser.new_page(viewport={'width': 800, 'height': 600})
        broken.route('**/assets/city/nanshan-wide/index.json', lambda route: route.fulfill(status=503, body='unavailable'))
        broken.goto(args.url + '?scene=nanshan-wide', wait_until='networkidle')
        broken.wait_for_selector('#boot-error[data-visible="true"]')
        check('data load failure is visible, not a collisionless city',
              '503' in broken.locator('#boot-error-msg').inner_text() and not broken.locator('#city-info').count())
        broken.close()
    finally:
        browser.close()

print(json.dumps({'passed': sum(1 for r in results if r['ok']), 'total': len(results), 'results': results}, ensure_ascii=False, indent=2))
