# -*- coding: utf-8 -*-
"""Docker Compose「一键体验」配置守卫（不需要 Docker 也能跑）。

为什么需要它：`docker compose up` 是本项目对外最容易被点开的那条路，
但本机/CI 都没有 Docker，改坏了没人会发现——直到评委点进来。所以这里把
「配置层面的硬要求」变成断言：服务/健康检查/依赖顺序/环境变量/卷/入口脚本/忽略清单/无明文密钥。

真正的运行时验证仍然需要 Docker（`docker compose up -d --build` 后用
demo@qqmini.dev / demo-qqmini-2026 登录，确认「AI 圆桌 · 演示」群已在）。
那一步写进 README，由有 Docker 的机器/评委执行；seed-demo 本身有 verify-seed-demo.mjs 守。

用法：python scripts/verify/verify-deploy-compose.py
"""

import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
problems = []
checked = 0


def check(name, ok, detail=""):
    global checked
    checked += 1
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail else ""))
    if not ok:
        problems.append(name)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def main():
    compose_path = os.path.join(ROOT, "docker-compose.yml")
    check("存在 docker-compose.yml", os.path.exists(compose_path))
    if not os.path.exists(compose_path):
        return finish()
    compose = yaml.safe_load(open(compose_path, encoding="utf-8"))
    services = compose.get("services") or {}
    check("声明了 db 与 app 两个服务", {"db", "app"} <= set(services), str(list(services)))

    app = services.get("app") or {}
    db = services.get("db") or {}

    dep = (app.get("depends_on") or {}).get("db") or {}
    check("app 依赖 db 且等待健康检查（condition: service_healthy）",
          dep.get("condition") == "service_healthy", str(dep))

    db_hc = (db.get("healthcheck") or {}).get("test") or []
    check("db 有 pg_isready 健康检查", any("pg_isready" in str(x) for x in db_hc), str(db_hc))

    ports = [str(p) for p in (app.get("ports") or [])]
    check("app 暴露 8787", any("8787" in p for p in ports), str(ports))

    env = app.get("environment") or {}
    required = ["DATABASE_URL", "WRITER_DATABASE_URL", "ADMIN_DATABASE_URL",
                "SESSION_SECRET", "SECURE_COOKIE", "PUBLIC_BASE_URL", "SIGNUP_MODE",
                "MEDIA_DIR", "PORT"]
    missing = [k for k in required if k not in env]
    check("app 环境变量齐全（DB×3/密钥/Cookie/公共地址/注册模式/媒体目录/端口）", not missing, str(missing))
    db_urls = [str(env.get(k, "")) for k in ("DATABASE_URL", "WRITER_DATABASE_URL", "ADMIN_DATABASE_URL")]
    check("三个 DB URL 都指向 compose 内的 db:5432",
          all("@db:5432" in u for u in db_urls), str(db_urls))
    check("SECURE_COOKIE 在本地演示里是 false（公网部署需改 true）",
          str(env.get("SECURE_COOKIE")) == "false", str(env.get("SECURE_COOKIE")))
    sig = str(env.get("SIGNUP_MODE"))
    check("演示环境的注册模式是 open（允许环境变量覆盖，默认 open）",
          sig == "open" or re.fullmatch(r"\$\{SIGNUP_MODE:-open\}", sig) is not None, sig)
    check("媒体目录是容器内独立路径 /data/media",
          str(env.get("MEDIA_DIR")) == "/data/media", str(env.get("MEDIA_DIR")))

    app_vols = [str(v) for v in (app.get("volumes") or [])]
    check("app 挂了媒体卷（重启不丢图）", any("/data/media" in v for v in app_vols), str(app_vols))
    vols = compose.get("volumes") or {}
    check("声明了命名卷 aio-db 与 aio-media", {"aio-db", "aio-media"} <= set(vols), str(list(vols)))

    # ---------------------------------------------------------------- Dockerfile
    dockerfile = read("Dockerfile")
    check("Dockerfile 是多阶段构建（web + runtime）",
          "AS web" in dockerfile and "AS runtime" in dockerfile)
    check("Dockerfile 构建前端（npm run build）", "npm run build" in dockerfile)
    for path in ("COPY src ./src", "COPY sql ./sql", "COPY scripts ./scripts"):
        check("Dockerfile 带上 %s" % path.replace("COPY ", ""), path in dockerfile)
    check("Dockerfile 从前端阶段拷 dist", "COPY --from=web" in dockerfile and "./web/dist" in dockerfile)
    check("Dockerfile 生产依赖用 npm ci --omit=dev", "npm ci --omit=dev" in dockerfile)
    check("容器以非 root 用户运行", re.search(r"^USER\s+node\s*$", dockerfile, re.M) is not None)

    # ---------------------------------------------------------------- entrypoint
    entry = read("docker/entrypoint.sh")
    check("入口脚本失败即退出（set -euo pipefail）", "set -euo pipefail" in entry)
    check("入口脚本会等数据库（连接重试循环）", "connect" in entry and "process.exit(1)" in entry)
    check("入口脚本先迁移再灌数据再起服务",
          entry.index("migrate.mjs") < entry.index("seed-demo.mjs") < entry.index("exec node src/index.mjs"))
    check("入口脚本把 seed-demo 当硬依赖（失败会非零退出）",
          "node scripts/seed-demo.mjs" in entry and "||" not in entry.split("seed-demo.mjs")[0].splitlines()[-1])

    # ---------------------------------------------------------------- 忽略清单 / 引用文件
    ignore = read(".dockerignore")
    check(".dockerignore 排除了世界仓库/临时目录/依赖目录",
          all(k in ignore for k in ("aio-world", "tmp", "node_modules")))
    for rel in ("docker/entrypoint.sh", "web/package.json", "web/package-lock.json"):
        check("被引用的文件存在：%s" % rel, os.path.exists(os.path.join(ROOT, rel)))

    # ---------------------------------------------------------------- 密钥卫生
    joined = compose_path and read("docker-compose.yml")
    check("compose 里没有明文 token（qqa_/PAT）", "qqa_" not in joined and "ghp_" not in joined)
    check("POSTGRES_PASSWORD 与 SESSION_SECRET 用环境变量插值（可覆盖）",
          "${POSTGRES_PASSWORD" in joined and "${SESSION_SECRET" in joined)

    return finish()


def finish():
    failed = len(problems)
    print("\n%s：%d/%d" % ("全部通过" if failed == 0 else "有失败", checked - failed, checked))
    if failed:
        print("失败项：" + "; ".join(problems))
        sys.exit(1)


if __name__ == "__main__":
    main()
