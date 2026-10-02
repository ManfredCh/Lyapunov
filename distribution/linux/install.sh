#!/bin/sh
# Public installer: curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
set -eu
umask 022
# Downloaded runtime tools own their imports; host Python/Node configuration
# must not choose another environment during per-version preparation.
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE PYTHONSTARTUP NODE_PATH NODE_OPTIONS
unset LYAPUNOV_NODE_BIN LYAPUNOV_MICROMAMBA
export PYTHONNOUSERSITE=1
stage=arguments
incoming=
lock=
link_pending=
cleanup() {
  status=$?
  [ -z "$incoming" ] || rm -rf -- "$incoming"
  [ -z "$link_pending" ] || rm -f -- "$link_pending"
  [ -z "$lock" ] || rmdir -- "$lock" 2>/dev/null || :
  if [ "$status" -ne 0 ]; then printf '%s\n' "Lyapunov [$stage] BLOCKED (exit $status). Existing current and user data were preserved." >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
fail() { printf '%s\n' "Lyapunov [$stage] $*" >&2; exit 2; }
log() { printf '%s\n' "Lyapunov [$stage] $*"; }
usage() {
  printf '%s\n' 'Usage: sh install.sh [--prefix PATH] [--bin-dir PATH] [--version RELEASE_ID] [--without-mujoco] [--no-desktop]' \
    'Default: Linux x64, per-user version directories, MuJoCo prepared and verified before activation.' \
    'LYAPUNOV_INSTALL_BASE_URL may explicitly select another HTTPS release mirror (HTTP is allowed only for localhost fixtures).'
}
: "${HOME:?HOME is required for a per-user installation}"
prefix=${LYAPUNOV_INSTALL_ROOT:-"$HOME/.local/share/lyapunov"}
bin_dir=${LYAPUNOV_INSTALL_BIN_DIR:-"$HOME/.local/bin"}
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
base_url=${LYAPUNOV_INSTALL_BASE_URL:-https://vorynel.com/lyapunov}
release_selector=latest
with_mujoco=true
with_desktop=true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --prefix|--bin-dir|--version)
      flag=$1; shift; [ "$#" -gt 0 ] || fail "$flag needs a value."
      case "$flag" in --prefix) prefix=$1 ;; --bin-dir) bin_dir=$1 ;; --version) release_selector=$1 ;; esac ;;
    --without-mujoco) with_mujoco=false ;;
    --no-desktop) with_desktop=false ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
safe_token() { case "$1" in ''|*[!A-Za-z0-9._-]*|.|..) return 1 ;; esac; }
safe_path() {
  case "$1" in /*) ;; *) fail "Install paths must be absolute: $1" ;; esac
  cr=$(printf '\r'); tab=$(printf '\t')
  case "$1" in *'
'*|*"$cr"*|*"$tab"*) fail 'Install paths cannot contain control characters.' ;; esac
}
safe_token "$release_selector" || fail 'Invalid release ID.'
for path in "$prefix" "$bin_dir" "$data_home"; do safe_path "$path"; done
if [ "$with_mujoco" = true ]; then
  # conda-unpack can exit 0 while a quote inserted into _sysconfigdata breaks
  # SciPy later. Reject this known unsupported SDK prefix before any download.
  case "$prefix" in *"'"*) fail 'CONDA_PREFIX_UNSUPPORTED: MuJoCo relocation requires --prefix without a single quote; spaces are supported.' ;; esac
fi
stage=platform
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'This release supports Linux x86_64 only.'
for tool in curl sha256sum tar mktemp getconf tee; do command -v "$tool" >/dev/null 2>&1 || fail "Required system command is missing: $tool"; done
case "$base_url" in
  https://*) protocols='=https' ;;
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) protocols='=http,https' ;;
  *) fail 'The release mirror must use HTTPS (localhost HTTP fixtures only).' ;;
esac
base_url=${base_url%/}
stage=prepare
mkdir -p -- "$prefix" "$bin_dir"
prefix=$(CDPATH= cd -- "$prefix" && pwd -P)
bin_dir=$(CDPATH= cd -- "$bin_dir" && pwd -P)
# The same per-user prefix has one installer owner; no version/data deletion.
if ! mkdir -- "$prefix/.install-lock" 2>/dev/null; then fail "Another installer owns $prefix/.install-lock; finish that install first."; fi
lock="$prefix/.install-lock"
mkdir -p -- "$prefix/versions" "$prefix/downloads"
incoming=$(mktemp -d "$prefix/.incoming.XXXXXX")
stage=manifest
log "Fetching $base_url/releases/$release_selector/linux-x64.tsv"
curl --fail --location --silent --show-error --proto "$protocols" --proto-redir "$protocols" --connect-timeout 30 --max-time 60 --retry 3 --retry-delay 2 \
  --output "$incoming/manifest.tsv" "$base_url/releases/$release_selector/linux-x64.tsv" || fail 'Release manifest download failed.'
seen='|'
while IFS="$(printf '\t')" read -r key value extra; do
  [ -n "$key" ] && [ -n "$value" ] && [ -z "$extra" ] || fail 'Malformed release manifest row.'
  case "$seen" in *"|$key|"*) fail "Duplicate manifest field: $key" ;; esac
  seen="$seen$key|"
  case "$key" in
    schema) schema=$value ;; release_id) release_id=$value ;; version) version=$value ;; platform) platform=$value ;;
    minimum_glibc) minimum_glibc=$value ;; source_commit) source_commit=$value ;;
    archive_path) archive_path=$value ;; archive_root) archive_root=$value ;; archive_sha256) archive_sha256=$value ;; archive_bytes) archive_bytes=$value ;;
    mujoco_mode) mujoco_mode=$value ;; mujoco_path) mujoco_path=$value ;; mujoco_sha256) mujoco_sha256=$value ;; mujoco_bytes) mujoco_bytes=$value ;; mujoco_minimum_glibc) mujoco_minimum_glibc=$value ;;
    *) fail "Unknown manifest field: $key" ;;
  esac
done < "$incoming/manifest.tsv"
[ "${schema:-}" = 1 ] && [ "${platform:-}" = linux-x64 ] || fail 'Unsupported or incomplete release manifest.'
for value in "${release_id:-}" "${version:-}" "${archive_root:-}"; do safe_token "$value" || fail 'Invalid release/package identity.'; done
[ "$release_selector" = latest ] || [ "$release_selector" = "$release_id" ] || fail 'Requested release ID differs from manifest.'
case "${source_commit:-}" in *[!0-9a-f]*|'') fail 'Missing source commit.' ;; esac
[ "${#source_commit}" -eq 40 ] || fail 'Source commit must have 40 hex characters.'
check_hash() { case "$1" in ''|*[!0-9a-f]*) fail 'Invalid archive SHA256.' ;; esac; [ "${#1}" -eq 64 ] || fail 'Archive SHA256 must have 64 hex characters.'; }
check_bytes() { case "$1" in ''|*[!0-9]*) fail 'Invalid archive byte count.' ;; esac; [ "$1" -gt 0 ] && [ "$1" -le 2147483648 ] || fail 'Archive size is outside the 2GiB release budget.'; }
check_download_path() {
  case "$1" in "releases/$release_id/"*) ;; *) fail 'Archive URL is outside this versioned release.' ;; esac
  file=${1#"releases/$release_id/"}
  safe_token "$file" || fail 'Invalid archive filename.'
  case "$file" in *.tar.gz) ;; *) fail 'Only tar.gz archives are supported.' ;; esac
}
check_hash "${archive_sha256:-}"; check_bytes "${archive_bytes:-}"; check_download_path "${archive_path:-}"
case "${mujoco_mode:-}" in
  conda-pack) check_hash "${mujoco_sha256:-}"; check_bytes "${mujoco_bytes:-}"; check_download_path "${mujoco_path:-}"
    [ "$((archive_bytes+mujoco_bytes))" -le 2147483648 ] || fail 'Main package and default MuJoCo exceed the 2GiB compressed release budget.' ;;
  install-provider) [ "${mujoco_path:-}" = none ] && [ "${mujoco_sha256:-}" = none ] && [ "${mujoco_bytes:-}" = 0 ] || fail 'Unexpected MuJoCo artifact fields.' ;;
  *) fail 'Missing or unsupported MuJoCo preparation mode.' ;;
esac
check_glibc() {
  case "$1" in *[!0-9.]*|''|.*|*.) fail 'Invalid minimum glibc version.' ;; esac
  required_major=${1%%.*}; required_minor=${1#*.}
  case "$required_minor" in *.*|'') fail 'Invalid minimum glibc version.' ;; esac
  actual=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'A supported glibc system is required (musl is not supported).'
  actual=${actual#glibc }; actual_major=${actual%%.*}; actual_minor=${actual#*.}
  case "$actual_major.$actual_minor" in *[!0-9.]*) fail 'Could not read glibc version.' ;; esac
  [ "$actual_major" -gt "$required_major" ] || { [ "$actual_major" -eq "$required_major" ] && [ "$actual_minor" -ge "$required_minor" ]; } || fail "glibc $1 or later is required; found $actual."
}
check_glibc "${minimum_glibc:-}"
if [ "$with_mujoco" = true ]; then check_glibc "${mujoco_minimum_glibc:-}"; fi
download() {
  url_path=$1; expected_hash=$2; expected_bytes=$3
  downloaded="$prefix/downloads/$expected_hash.tar.gz"
  if [ -f "$downloaded" ]; then
    actual_hash=$(sha256sum "$downloaded"); actual_hash=${actual_hash%% *}
    if [ "$actual_hash" = "$expected_hash" ] && [ "$(wc -c < "$downloaded" | tr -d ' ')" = "$expected_bytes" ]; then log 'Reusing verified download.'; return; fi
    fail "Cached download failed verification: $downloaded"
  fi
  partial="$downloaded.partial"
  log "Downloading $url_path ($expected_bytes bytes); interrupted downloads resume here: $partial"
  curl --fail --location --show-error --progress-bar --proto "$protocols" --proto-redir "$protocols" --connect-timeout 30 --speed-limit 1024 --speed-time 60 --retry 3 --retry-delay 2 \
    --continue-at - --output "$partial" "$base_url/$url_path" || fail "Archive download failed; partial download retained: $partial"
  [ "$(wc -c < "$partial" | tr -d ' ')" = "$expected_bytes" ] || fail "Archive byte count mismatch: $partial"
  actual_hash=$(sha256sum "$partial"); actual_hash=${actual_hash%% *}
  [ "$actual_hash" = "$expected_hash" ] || fail "Archive SHA256 mismatch: $partial"
  mv -- "$partial" "$downloaded"
}
safe_archive() {
  tar -tzf "$1" > "$incoming/archive.paths" || fail 'Archive is truncated or unreadable.'
  while IFS= read -r entry; do
    case "$entry" in /*|../*|*/../*|*/..|..) fail 'Archive contains an unsafe member path.' ;; esac
    if [ "$2" != runtime ]; then case "$entry" in "$archive_root"|"$archive_root/"*) ;; *) fail 'Archive has an unexpected top-level directory.' ;; esac; fi
  done < "$incoming/archive.paths"
}
package_identity() {
  [ -x "$1/runtime/node/bin/node" ] && [ -x "$1/lyapunov" ] && [ -f "$1/RELEASE.json" ] || fail 'Package entry, bundled Node or RELEASE.json is missing.'
  "$1/runtime/node/bin/node" -e 'const fs=require("node:fs"),p=require("node:path");const [root,version,commit,id]=process.argv.slice(1);const row=JSON.parse(fs.readFileSync(p.join(root,"RELEASE.json"),"utf8"));if(row.releaseId!==id||row.version!==version||row.platform!=="linux-x64"||row.sourceCommit!==commit||row.sourceCommitMatchesPayload!==true||row.userDataBundled!==false)throw Error("Package/source identity differs from release manifest");' "$1" "$version" "$source_commit" "$release_id" || fail 'Verified archive has an inconsistent package identity.'
}
product="$prefix/versions/$release_id"
stage=package
if [ -e "$product" ] || [ -L "$product" ]; then
  [ -d "$product" ] && [ ! -L "$product" ] && [ -f "$product/.install/archive.sha256" ] || fail "Version directory is not owned by this installer: $product"
  [ "$(cat "$product/.install/archive.sha256")" = "$archive_sha256" ] || fail 'Existing release ID has a different archive identity.'
  package_identity "$product"
  log "Resuming verified version $release_id"
else
  download "$archive_path" "$archive_sha256" "$archive_bytes"
  safe_archive "$downloaded" package
  tar --no-same-owner --no-same-permissions -xzf "$downloaded" -C "$incoming" || fail 'Package extraction failed.'
  package_identity "$incoming/$archive_root"
  # Conda relocation must run at the final prefix; do not move it afterwards.
  mv -- "$incoming/$archive_root" "$product"
  mkdir -p -- "$product/.install"
  printf '%s\n' "$archive_sha256" > "$product/.install/archive.sha256"
fi
cp -- "$incoming/manifest.tsv" "$product/.install/release.tsv"
if [ "$with_mujoco" = true ]; then
  stage=mujoco
  if [ "$mujoco_mode" = conda-pack ]; then
    runtime="$product/.runtime/sim-python"
    if [ -f "$product/.install/mujoco.sha256" ]; then
      [ "$(cat "$product/.install/mujoco.sha256")" = "$mujoco_sha256" ] || fail 'Existing MuJoCo runtime has a different archive identity.'
    else
      [ ! -e "$runtime" ] && [ ! -L "$runtime" ] || fail "Unfinished/unowned MuJoCo runtime retained: $runtime; inspect or rename it before retrying."
      download "$mujoco_path" "$mujoco_sha256" "$mujoco_bytes"
      safe_archive "$downloaded" runtime
      mkdir -p -- "$runtime"
      tar --no-same-owner --no-same-permissions -xzf "$downloaded" -C "$runtime" || fail 'MuJoCo runtime extraction failed.'
      [ -x "$runtime/bin/python" ] && [ -f "$runtime/bin/conda-unpack" ] || fail 'MuJoCo archive lacks Python or conda-unpack.'
      log 'Relocating the Conda runtime at its final version directory.'
      "$runtime/bin/python" -I "$runtime/bin/conda-unpack" || fail "Conda relocation failed at $runtime."
      printf '%s\n' "$mujoco_sha256" > "$product/.install/mujoco.sha256"
    fi
    "$runtime/bin/python" -I -c 'import os,sys,mujoco,mink,ompl,daqp,numpy,scipy,trimesh,coacd,zmq,msgpack,msgpack_numpy; from importlib.metadata import version; assert os.path.realpath(sys.prefix)==os.path.realpath(sys.argv[1]); assert not sys.flags.no_user_site==0; expected={"mujoco":"3.13.0","mink":"1.3.0","ompl":"2.0.1","daqp":"0.9.1","coacd":"1.0.7","trimesh":"5.1.0","pyzmq":"27.2.0","msgpack":"1.2.2","msgpack-numpy":"0.4.8"}; assert all(version(name)==pin for name,pin in expected.items())' "$runtime" || fail 'Relocated MuJoCo dependency/native closure is unavailable.'
  elif [ ! -f "$product/.install/mujoco-provider-ready" ]; then
    log 'Preparing MuJoCo with the packaged install-provider; Python/Conda/pip progress follows.'
    # install-provider also runs doctor. If only desktop sandbox blocks, keep the
    # prefix and continue to the same doctor below; never mask provider failure.
    (
      set +e
      "$product/lyapunov" install-provider mujoco 2>&1
      printf '%s\n' "$?" > "$product/.install/provider.exit"
    ) | tee "$product/.install/provider.log"
    provider_exit=$(cat "$product/.install/provider.exit")
    if [ "$provider_exit" -ne 0 ]; then
      # Only the actual installer terminal JSON can distinguish a ready SDK
      # plus desktop block from a download/pip/provider failure.
      "$product/runtime/node/bin/node" -e 'const fs=require("node:fs");const [log,code]=process.argv.slice(1);const text=fs.readFileSync(log,"utf8");let row;for(let n=text.lastIndexOf("{");n>=0;n=text.lastIndexOf("{",n-1)){try{row=JSON.parse(text.slice(n));break}catch{}}if(code!=="2"||row?.status!=="BLOCKED"||row?.providers?.mujoco?.status!=="AVAILABLE"||row?.desktop?.status!=="BLOCKED")throw Error("install-provider failed before a verified MuJoCo SDK; see "+log);' "$product/.install/provider.log" "$provider_exit" || fail "MuJoCo installation failed (exit $provider_exit); partial prefix and logs were retained."
    fi
    : > "$product/.install/mujoco-provider-ready"
  fi
fi
stage=doctor
log 'Checking the installed product with its normal doctor.'
if [ "$with_mujoco" = true ]; then
  "$product/lyapunov" doctor mujoco --managed-sdk || fail "Doctor blocked activation; the verified SDK and version remain at $product. Follow its reported remedy and rerun this installer."
  stage=physics
  "$product/lyapunov" physics-check --managed-sdk || fail 'Native MuJoCo physics check failed; the previous version remains current.'
else
  # Explicitly slim installs still check desktop and sandbox, with no provider.
  "$product/lyapunov" doctor desktop || fail "Desktop doctor blocked activation; follow its reported remedy for $product."
fi
stage=entry
previous=
if [ -e "$prefix/current" ] || [ -L "$prefix/current" ]; then
  [ -L "$prefix/current" ] || fail "Refusing to replace an unmanaged current directory: $prefix/current"
  previous=$(readlink "$prefix/current")
  case "$previous" in versions/*) old=${previous#versions/}; safe_token "$old" || fail 'Unsafe previous version link.' ;; *) fail 'Current points outside the version directory.' ;; esac
fi
if [ -e "$prefix/previous" ] || [ -L "$prefix/previous" ]; then
  [ -L "$prefix/previous" ] || fail "Refusing to replace unmanaged rollback state: $prefix/previous"
  previous_saved=$(readlink "$prefix/previous")
  case "$previous_saved" in versions/*) old=${previous_saved#versions/}; safe_token "$old" || fail 'Unsafe rollback link.' ;; *) fail 'Rollback link points outside the version directory.' ;; esac
fi
# Generate stable wrapper and XDG entry with the packaged Node, after all checks.
"$product/runtime/node/bin/node" "$product/distribution/linux/install-entry.mjs" "$prefix" "$bin_dir" "$data_home" "$with_desktop" || fail 'Could not prepare the per-user launcher or desktop entry.'
stage=activate
if [ -n "$previous" ] && [ "$previous" != "versions/$release_id" ]; then
  link_pending="$prefix/.previous.$$"; ln -s -- "$previous" "$link_pending"; mv -Tf -- "$link_pending" "$prefix/previous"; link_pending=
fi
link_pending="$prefix/.current.$$"; ln -s -- "versions/$release_id" "$link_pending"; mv -Tf -- "$link_pending" "$prefix/current"; link_pending=
stage=complete
if [ "$with_mujoco" = true ]; then log "READY: $release_id; managed MuJoCo doctor and native physics passed."; else log "INSTALLED_WITHOUT_MUJOCO: $release_id (explicit --without-mujoco)."; fi
log "Start with: $bin_dir/lyapunov"
if [ -n "$previous" ] && [ "$previous" != "versions/$release_id" ]; then log "Previous version retained at $prefix/$previous; rollback link: $prefix/previous"; fi
