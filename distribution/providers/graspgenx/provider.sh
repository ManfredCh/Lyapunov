#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export HF_ENDPOINT=https://hf-mirror.com
export HF_HUB_DISABLE_XET=1
compose() { docker compose --project-directory "$root" -f "$root/compose.yaml" "$@"; }
terms() {
  # New production variable; the legacy variable is read only as explicit compatibility.
  accepted=${LYAPUNOV_GRASPGENX_TERMS_ACCEPTED:-${LYAUP_GRASPGENX_TERMS_ACCEPTED:-}}
  if [ "$accepted" != I_ACKNOWLEDGE_GRASPGENX_MODEL_AND_ASSET_TERMS ]; then
    printf '%s\n' '{"status":"BLOCKED","code":"LICENSE_CONFIRMATION_REQUIRED","message":"先阅读本目录许可记录；下载或启动前需显式设置 LYAPUNOV_GRASPGENX_TERMS_ACCEPTED。旧 LYAUP_GRASPGENX_TERMS_ACCEPTED 仅作兼容读取。"}' >&2
    exit 2
  fi
}
case "${1:-help}" in
  check)
    compose --profile assets config --quiet
    compose --profile assets build --print
    ;;
  reuse)
    if [ "$#" -ne 2 ]; then printf '%s\n' '用法：./provider.sh reuse <已有容器名或ID>' >&2; exit 2; fi
    running=$(docker inspect "$2" --format '{{.State.Running}}')
    provider=$(docker inspect "$2" --format '{{index .Config.Labels "io.lyapunov.grasp-provider"}}')
    # Existing pre-migration containers may carry the old label; never infer or rename it.
    if [ -z "$provider" ] || [ "$provider" = "<no value>" ]; then provider=$(docker inspect "$2" --format '{{index .Config.Labels "io.lyapunov.grasp-provider"}}'); fi
    if [ "$running" != true ] || [ "$provider" != graspgenx ]; then
      printf '%s\n' '{"status":"BLOCKED","code":"PROVIDER_UNAVAILABLE","message":"指定容器不是正在运行的GraspGenX worker。"}' >&2; exit 2
    fi
    docker inspect "$2" --format '{"status":"AVAILABLE","scope":"已有容器身份和状态；未执行推理","container":{{json .Name}},"image":{{json .Image}},"pid":{{json .State.Pid}}}'
    printf 'LYAPUNOV_GRASPGENX_CONTAINER=%s\n' "$2"
    ;;
  build)
    compose --profile assets build assets worker
    ;;
  assets)
    terms
    for volume in "${GRASPGENX_MODEL_VOLUME:-lyapunov-graspgenx-models-7c834043c11a}" "${GRASPGENX_GRIPPER_VOLUME:-lyapunov-graspgenx-grippers-19a03c00d19a}"; do
      if ! docker volume inspect "$volume" >/dev/null 2>&1; then docker volume create "$volume" >/dev/null; fi
    done
    compose --profile assets run --rm --no-deps assets
    ;;
  start)
    existing=$(docker ps --filter label=io.lyapunov.grasp-provider=graspgenx --format '{{.Names}}')
    # Discover legacy workers only by their explicit legacy label for safe reuse.
    if [ -z "$existing" ]; then existing=$(docker ps --filter label=io.lyapunov.grasp-provider=graspgenx --format '{{.Names}}'); fi
    if [ -n "$existing" ]; then
      printf '%s\n' '已有 GraspGenX worker，复用该容器；本入口不启动第二份GPU进程。' "$existing" '使用 ./provider.sh reuse <上面的容器名> 获取配置。'
      exit 0
    fi
    terms
    compose up --detach --no-build --no-deps --wait worker
    compose ps --format json worker
    ;;
  *)
    printf '%s\n' './provider.sh check                  # 只读Compose与构建配置' './provider.sh reuse <container>      # 只读复用已有worker' './provider.sh build                  # 显式构建独立镜像，不启动GPU' './provider.sh assets                 # 明确许可后下载/验证指定资产卷' './provider.sh start                  # 无已有worker时才启动本项目worker'
    ;;
esac
