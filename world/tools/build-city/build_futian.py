"""兼容包装：福田街区数据生成器（历史入口）。

生成逻辑与场景配置已统一到 `build_city.py`（一个场景一条配置，几何管线只有一份）。
本文件只保留旧名字：`python world/tools/build-city/build_futian.py` 仍然重生成
`world/assets/city/futian.json`，`test_futian.py` 也继续从这里 import，不要删。
"""

from build_city import BBOX, HERE, ORIGIN, WORLD, build, local  # noqa: F401  旧入口名字

if __name__ == '__main__':
    from build_city import main

    main(['--scene', 'futian'])
