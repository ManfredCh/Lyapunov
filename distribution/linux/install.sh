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
legacy_pending=
desktop_entry=
entry_transaction=
cleanup() {
  status=$?
  if [ -n "$entry_transaction" ] && [ -f "$entry_transaction" ]; then
    legacy_pending=$(cat "$entry_transaction")
  fi
  if [ -n "$legacy_pending" ] && [ "$legacy_pending" = "$desktop_entry.lyapunov-upgrade-pending" ] && [ -f "$legacy_pending" ]; then
    if [ "$status" -eq 0 ]; then rm -f -- "$legacy_pending"; else
      "$product/runtime/node/bin/node" -e 'const fs=require("node:fs");const [pending,entry]=process.argv.slice(1);if(fs.existsSync(entry)&&!fs.readFileSync(entry,"utf8").split("\n").includes(process.env.LYAPUNOV_ENTRY_MARKER))throw Error("Entry changed concurrently; original preserved at "+pending);fs.renameSync(pending,entry);' "$legacy_pending" "$desktop_entry" || printf '%s\n' "Original desktop entry retained at $legacy_pending; automatic restoration was blocked." >&2
    fi
    [ -f "$legacy_pending" ] || rm -f -- "$entry_transaction"
  fi
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
read_available_bytes() {
  storage_available=
  command -v df >/dev/null 2>&1 || return 1
  storage_report=$(LC_ALL=C df -Pk "${1:-$prefix/downloads}" 2>/dev/null) || return 1
  {
    read -r storage_header
    read -r storage_filesystem storage_total storage_used storage_kib storage_percent storage_mount
  } <<STORAGE_REPORT
$storage_report
STORAGE_REPORT
  for storage_number in "$storage_total" "$storage_used" "$storage_kib"; do
    case "$storage_number" in ''|*[!0-9]*) return 1 ;; esac
  done
  case "$storage_percent" in *%) storage_percent=${storage_percent%\%} ;; *) return 1 ;; esac
  case "$storage_percent" in ''|*[!0-9]*) return 1 ;; esac
  # Keep POSIX shell arithmetic bounded; unexpected df output is unknown,
  # never zero available space. Linux/WSL df -Pk emits decimal KiB values.
  [ "${#storage_kib}" -le 15 ] || return 1
  while [ "$storage_kib" != 0 ] && [ "${storage_kib#0}" != "$storage_kib" ]; do storage_kib=${storage_kib#0}; done
  storage_available=$((storage_kib * 1024))
}
write_failed() {
  storage_target=$1; storage_requirement=$2
  if read_available_bytes "${3:-$prefix/downloads}"; then
    storage_free="$storage_available bytes"
    if [ "$storage_available" -eq 0 ]; then storage_reason='The destination filesystem reports no available space.'; else storage_reason='Check filesystem space and write permissions.'; fi
  else
    storage_free=unknown; storage_reason='Available space could not be measured; check filesystem space and write permissions.'
  fi
  stage=storage
  fail "STORAGE_WRITE_FAILED: curl exit 23 writing target=$storage_target; available=$storage_free; $storage_requirement $storage_reason Free space or resolve write access, then rerun the same curl installer to resume. Current, previous, user data and partial downloads are preserved."
}
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
if curl --fail --location --silent --show-error --proto "$protocols" --proto-redir "$protocols" --connect-timeout 30 --max-time 60 --retry 3 --retry-delay 2 \
  --output "$incoming/manifest.tsv" "$base_url/releases/$release_selector/linux-x64.tsv"; then :; else
  curl_exit=$?
  [ "$curl_exit" -ne 23 ] || write_failed "$incoming/manifest.tsv" 'Remaining archive download size is unknown until the release manifest is read.' "$incoming"
  fail "Release manifest download failed (curl exit $curl_exit)."
fi
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
remaining_download_bytes() {
  partial_bytes=0
  if [ -f "$partial" ]; then partial_bytes=$(wc -c < "$partial" 2>/dev/null | tr -d ' '); fi
  case "$partial_bytes" in ''|*[!0-9]*) return 1 ;; esac
  [ "$partial_bytes" -le "$expected_bytes" ] 2>/dev/null || return 1
  remaining_bytes=$((expected_bytes - partial_bytes))
}
check_download_space() {
  if read_available_bytes; then
    if [ "$storage_available" -lt "$remaining_bytes" ]; then
      stage=storage
      fail "STORAGE_INSUFFICIENT: target=$partial; available=$storage_available bytes; remaining download requires at least $remaining_bytes bytes. Free space, then rerun the same curl installer to resume. Current, previous, user data and partial downloads are preserved. Extraction/runtime preparation needs additional space not specified by this manifest."
    fi
  else
    printf '%s\n' "Lyapunov [storage] STORAGE_CHECK_UNAVAILABLE: target=$partial; available=unknown (df is unavailable or unreadable); remaining download requires at least $remaining_bytes bytes. Continuing without a space precheck; check filesystem space if the download fails. Only compressed download bytes can be checked; extraction/runtime preparation needs additional space not specified by this manifest." >&2
  fi
}
download_write_failed() {
  if remaining_download_bytes; then storage_need="remaining download requires at least $remaining_bytes bytes."; else storage_need='Remaining download size could not be read.'; fi
  write_failed "$partial" "$storage_need"
}
download() {
  url_path=$1; expected_hash=$2; expected_bytes=$3
  downloaded="$prefix/downloads/$expected_hash.tar.gz"
  if [ -f "$downloaded" ]; then
    actual_hash=$(sha256sum "$downloaded"); actual_hash=${actual_hash%% *}
    if [ "$actual_hash" = "$expected_hash" ] && [ "$(wc -c < "$downloaded" | tr -d ' ')" = "$expected_bytes" ]; then log 'Reusing verified download.'; return; fi
    fail "Cached download failed verification: $downloaded"
  fi
  partial="$downloaded.partial"
  remaining_download_bytes || fail "Partial download size cannot be resumed; inspect the retained file: $partial"
  if [ "$remaining_bytes" -gt 0 ]; then
    check_download_space
    log "Downloading $url_path ($expected_bytes bytes); interrupted downloads resume here: $partial"
    if curl --fail --location --show-error --progress-bar --proto "$protocols" --proto-redir "$protocols" --connect-timeout 30 --speed-limit 1024 --speed-time 60 --retry 3 --retry-delay 2 \
      --continue-at - --output "$partial" "$base_url/$url_path"; then :; else
      curl_exit=$?
      [ "$curl_exit" -ne 23 ] || download_write_failed
      fail "Archive download failed (curl exit $curl_exit); partial download retained: $partial"
    fi
  fi
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
doctor_log="$product/.install/doctor.log"
run_doctor() {
  if [ "$with_mujoco" = true ]; then
    "$product/lyapunov" doctor mujoco --managed-sdk > "$doctor_log" 2>&1
  else
    "$product/lyapunov" doctor desktop > "$doctor_log" 2>&1
  fi
}
prepare_desktop_libraries() {
  desktop_doctor_ready=false
  # The bootstrap also serves already downloaded releases. Keep this bounded
  # mapping here so a dependency remedy never requires a replacement archive.
  if dependency_groups=$("$product/runtime/node/bin/node" -e '
    // BEGIN_DESKTOP_DEPENDENCY_PLAN
    const f=require("node:fs"),p=require("node:path"),cp=require("node:child_process");
    const [file,root,withMu]=process.argv.slice(1),blocked=code=>{console.error(code);process.exit(2)};
    let d;try{d=JSON.parse(f.readFileSync(file,"utf8"))}catch{blocked("DESKTOP_DEPENDENCY_REPORT_INVALID")}
    if(d?.desktop?.code!=="DESKTOP_LIBRARIES_MISSING")process.exit(3);
    const rows=d.desktop.missingSystemLibraries;
    if(d.status!=="BLOCKED"||d.desktop.status!=="BLOCKED"||!Array.isArray(rows)||!rows.length||rows.length>64||withMu==="true"&&d.providers?.mujoco?.status!=="AVAILABLE")blocked("DESKTOP_DEPENDENCY_REPORT_INVALID");
    const sonames=lines=>lines.map(line=>{const match=/^\s*([A-Za-z0-9.+_-]+\.so(?:\.[0-9]+)*)\s*=>\s*not found\s*$/.exec(line);if(!match)blocked("DESKTOP_DEPENDENCY_REPORT_INVALID");return match[1]}).sort();
    const reported=sonames(rows),check=cp.spawnSync("ldd",[p.join(root,"runtime/electron/lyapunov-desktop")],{encoding:"utf8",env:{...process.env,LC_ALL:"C"},timeout:15000});
    if(check.error||check.status!==0)blocked("DESKTOP_LIBRARY_CHECK_UNAVAILABLE");
    const actual=sonames(check.stdout.split("\n").filter(line=>line.includes("not found")));
    if(JSON.stringify(actual)!==JSON.stringify(reported))blocked("DESKTOP_DEPENDENCY_REPORT_CHANGED");
    const groups=[
      [["libglib-2.0.so.0","libgobject-2.0.so.0","libgio-2.0.so.0","libgmodule-2.0.so.0"],["libglib2.0-0t64","libglib2.0-0"]],
      [["libnss3.so","libnssutil3.so","libsmime3.so","libssl3.so"],["libnss3"]],
      [["libnspr4.so","libplc4.so","libplds4.so"],["libnspr4"]],
      [["libatk-1.0.so.0"],["libatk1.0-0t64","libatk1.0-0"]],
      [["libatk-bridge-2.0.so.0"],["libatk-bridge2.0-0t64","libatk-bridge2.0-0"]],
      [["libatspi.so.0"],["libatspi2.0-0t64","libatspi2.0-0"]],
      [["libcups.so.2"],["libcups2t64","libcups2"]],
      [["libdbus-1.so.3"],["libdbus-1-3"]],
      [["libcairo.so.2"],["libcairo2"]],[["libcairo-gobject.so.2"],["libcairo-gobject2"]],
      [["libgtk-3.so.0","libgdk-3.so.0"],["libgtk-3-0t64","libgtk-3-0"]],
      [["libpango-1.0.so.0"],["libpango-1.0-0"]],[["libpangocairo-1.0.so.0"],["libpangocairo-1.0-0"]],
      [["libX11.so.6"],["libx11-6"]],[["libXcomposite.so.1"],["libxcomposite1"]],
      [["libXdamage.so.1"],["libxdamage1"]],[["libXext.so.6"],["libxext6"]],
      [["libXfixes.so.3"],["libxfixes3"]],[["libXrandr.so.2"],["libxrandr2"]],
      [["libgbm.so.1"],["libgbm1"]],[["libdrm.so.2"],["libdrm2"]],
      [["libexpat.so.1"],["libexpat1"]],[["libxcb.so.1"],["libxcb1"]],
      [["libxkbcommon.so.0"],["libxkbcommon0"]],[["libudev.so.1"],["libudev1"]],
      [["libasound.so.2"],["libasound2t64","libasound2"]]
    ];
    const packages=[];for(const name of actual){const row=groups.find(group=>group[0].includes(name));if(!row)blocked("DESKTOP_LIBRARY_UNMAPPED: "+name);if(!packages.includes(row[1].join(" ")))packages.push(row[1].join(" "))}
    let os;try{os=f.readFileSync("/etc/os-release","utf8")}catch{blocked("DESKTOP_DEPENDENCY_OS_UNSUPPORTED")}
    const id=/^ID=(?:"([a-z0-9_-]+)"|([a-z0-9_-]+))\s*$/m.exec(os);
    if(!["ubuntu","debian"].includes(id?.[1]??id?.[2]))blocked("DESKTOP_DEPENDENCY_OS_UNSUPPORTED");
    console.log(packages.join("\n"));
    // END_DESKTOP_DEPENDENCY_PLAN
  ' "$doctor_log" "$product" "$with_mujoco"); then :; else
    dependency_status=$?
    [ "$dependency_status" -ne 3 ] || return 0
    fail "DESKTOP_DEPENDENCIES_BLOCKED: no system changes were attempted. Details: $doctor_log"
  fi
  stage=desktop-dependencies
  if ! ( : < /dev/tty ) 2>/dev/null; then
    fail "DESKTOP_DEPENDENCIES_TERMINAL_REQUIRED: Run the same installer in a normal interactive terminal for OS authorization. Details: $doctor_log"
  fi
  for tool in sudo apt-get apt-cache; do command -v "$tool" >/dev/null 2>&1 || fail "DESKTOP_DEPENDENCIES_COMMAND_MISSING: $tool"; done
  dependency_log="$product/.install/desktop-dependencies.log"
  log 'Preparing the missing desktop libraries through your OS package manager. Enter a password only at the system prompt; installation will resume automatically.'
  # Updating package metadata does not upgrade the OS. The distro selects its
  # own signed packages; never add repositories, a full desktop, or SDK tools.
  if sudo -p 'Lyapunov desktop dependencies authorization, password for %u: ' -- apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update < /dev/tty > "$dependency_log" 2>&1; then :; else
    fail "DESKTOP_DEPENDENCIES_UPDATE_FAILED: OS authorization or package metadata download failed. Details: $dependency_log"
  fi
  packages=
  while IFS= read -r candidates; do
    selected=
    for package in $candidates; do
      candidate=$(LC_ALL=C apt-cache policy "$package" 2>/dev/null | sed -n 's/^[[:space:]]*Candidate:[[:space:]]*//p')
      case "$candidate" in ''|'(none)') continue ;; esac
      selected=$package; break
    done
    [ -n "$selected" ] || fail "DESKTOP_DEPENDENCY_PACKAGE_UNAVAILABLE: $candidates. Details: $dependency_log"
    packages="$packages $selected"
  done <<DEPENDENCY_GROUPS
$dependency_groups
DEPENDENCY_GROUPS
  log "Installing only the packages selected for missing libraries:$packages"
  # All words originate in the fixed mapping above, not doctor command text.
  # apt resolves required dependencies, but removes no installed packages.
  if sudo -p 'Lyapunov desktop dependencies authorization, password for %u: ' -- apt-get -o Acquire::Retries=3 install --yes --no-install-recommends --no-upgrade --no-remove $packages < /dev/tty >> "$dependency_log" 2>&1; then :; else
    fail "DESKTOP_DEPENDENCIES_INSTALL_FAILED: required packages were not installed. Details: $dependency_log"
  fi
  stage=doctor
  log 'Rechecking the installed product after desktop dependency preparation.'
  # A real sandbox block may now become visible. Only the original sandbox
  # gate below can authorize it; a remaining library failure stays blocked.
  if run_doctor; then desktop_doctor_ready=true; else log "Desktop dependency preparation finished; checking the normal doctor remedy. Details: $doctor_log"; fi
}
# Git is used by normal workspace operations before the first model request.
# Prepare it through the same bounded OS authorization lane, never SDK edits.
require_runtime_git() {
  git_ready() {
    "$product/runtime/node/bin/node" -e 'const cp=require("node:child_process"),r=cp.spawnSync("git",["--version"],{encoding:"utf8",timeout:10000});process.exit(!r.error&&r.status===0&&/^git version \d/.test(String(r.stdout).trim())?0:2)' >/dev/null 2>&1
  }
  if git_ready; then return 0; fi
  stage=runtime-git
  log 'Preparing the required Git runtime tool. / 准备必需的 Git 运行工具。'
  "$product/runtime/node/bin/node" -e 'const f=require("node:fs"),os=f.readFileSync("/etc/os-release","utf8"),id=/^ID=(?:"([a-z0-9_-]+)"|([a-z0-9_-]+))\s*$/m.exec(os);process.exit(["ubuntu","debian"].includes(id?.[1]??id?.[2])?0:2)' || fail 'RUNTIME_GIT_OS_UNSUPPORTED: install Git through your OS package manager and rerun the installer. / 请通过系统包管理器安装 Git 后重跑安装命令。'
  ( : </dev/tty ) 2>/dev/null || fail 'RUNTIME_GIT_TERMINAL_REQUIRED: rerun in a normal interactive terminal for OS authorization. / 请在普通交互终端重跑并完成系统授权。'
  for tool in sudo apt-get apt-cache; do command -v "$tool" >/dev/null 2>&1 || fail "RUNTIME_GIT_COMMAND_MISSING: $tool"; done
  git_log="$product/.install/runtime-git.log"
  if sudo -p 'Lyapunov Git runtime authorization, password for %u: ' -- apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update < /dev/tty > "$git_log" 2>&1; then :; else
    fail "RUNTIME_GIT_UPDATE_FAILED: OS authorization or metadata download failed. / 系统授权或软件包元数据下载失败。 Details: $git_log"
  fi
  git_candidate=$(LC_ALL=C apt-cache policy git 2>/dev/null | sed -n 's/^[[:space:]]*Candidate:[[:space:]]*//p')
  case "$git_candidate" in ''|'(none)') fail "RUNTIME_GIT_PACKAGE_UNAVAILABLE: git. Details: $git_log" ;; esac
  if sudo -p 'Lyapunov Git runtime authorization, password for %u: ' -- apt-get -o Acquire::Retries=3 install --yes --no-install-recommends --no-upgrade --no-remove git < /dev/tty >> "$git_log" 2>&1; then :; else
    fail "RUNTIME_GIT_INSTALL_FAILED: Git was not installed. / Git 未安装成功。 Details: $git_log"
  fi
  git_ready || fail "RUNTIME_GIT_UNAVAILABLE_AFTER_PREPARATION: check the normal terminal PATH and rerun. / 请检查普通终端 PATH 后重跑。 Details: $git_log"
  stage=doctor
}
require_runtime_git
if run_doctor; then :; else
  prepare_desktop_libraries
  if [ "$desktop_doctor_ready" = true ]; then :; else
  # Only this package's real helper and an otherwise ready doctor may request
  # normal OS authorization. CONTEXT_ONLY is never promoted to readiness.
  if sandbox_code=$("$product/runtime/node/bin/node" -e '
    const fs=require("node:fs"),p=require("node:path");const [log,root,mu]=process.argv.slice(1);
    const blocked=code=>{console.log(code);process.exit(2)};let d;
    try{d=JSON.parse(fs.readFileSync(log,"utf8"))}catch{blocked("DOCTOR_REPORT_INVALID")}
    const desktop=d?.desktop,s=desktop?.sandbox;
    if(d?.status!=="BLOCKED"||desktop?.status!=="BLOCKED")blocked("DOCTOR_CHECK_FAILED");
    if(desktop.code!=="SANDBOX_SETUP_REQUIRED")blocked(desktop.code??"DOCTOR_CHECK_FAILED");
    if(!d.providers||mu==="true"&&d.providers.mujoco?.status!=="AVAILABLE"||Object.values(d.providers).some(row=>row.status!=="AVAILABLE"))blocked("PROVIDER_UNAVAILABLE");
    if(!Array.isArray(desktop.missingSystemLibraries)||desktop.missingSystemLibraries.length)blocked("DESKTOP_LIBRARIES_MISSING");
    if(s?.status!=="BLOCKED"||s.code!=="SANDBOX_SETUP_REQUIRED")blocked("SANDBOX_STATE_UNCONFIRMED");
    if(s.noNewPrivileges!==false)blocked("SANDBOX_NO_NEW_PRIVILEGES");
    if(s.nosuid!==false)blocked(s.nosuid===true?"SANDBOX_NOSUID":"SANDBOX_MOUNT_UNCONFIRMED");
    const helper=p.join(root,"runtime/electron/chrome-sandbox");let actual;
    try{actual=fs.lstatSync(helper)}catch{blocked("SANDBOX_HELPER_MISSING")}
    if(s.helper?.path!==helper||s.helper.exists!==true||!actual.isFile()||actual.isSymbolicLink()||actual.size===0||s.helper.uid!==actual.uid||s.helper.mode!==(actual.mode&0o7777))blocked("SANDBOX_HELPER_INVALID");
    console.log("SANDBOX_SETUP_REQUIRED");
  ' "$doctor_log" "$product" "$with_mujoco"); then
    stage=sandbox
    if ! ( : < /dev/tty ) 2>/dev/null; then
      fail "SANDBOX_TERMINAL_REQUIRED: Run the same installer in a regular interactive terminal so your OS can authorize this package. Details: $doctor_log"
    fi
    command -v sudo >/dev/null 2>&1 || fail "SANDBOX_SUDO_MISSING: This OS needs sudo for this package's sandbox setup. Install it through your system administrator, then rerun this installer."
    log 'Completing installation: your OS needs one-time sandbox setup authorization. Installation will resume automatically; enter your password only at the system prompt.'
    # curl|sh owns stdin. sudo and its command receive the controlling terminal,
    # never the script stream; only the existing setup-sandbox command is elevated.
    if sudo -p 'Lyapunov one-time sandbox authorization, password for %u: ' -- "$product/lyapunov" setup-sandbox < /dev/tty > "$product/.install/sandbox-setup.log"; then :; else
      fail "SANDBOX_AUTHORIZATION_FAILED: OS authorization or sandbox setup did not complete. The verified version is preserved; rerun the same installer when authorization is available."
    fi
    stage=doctor
    log 'Sandbox setup finished; checking the product again.'
    run_doctor || fail "SANDBOX_RECHECK_FAILED: The normal doctor still blocks activation. Details: $doctor_log"
  else
    log "$sandbox_code: the verified version remains pending."
    case "$sandbox_code" in
      SANDBOX_CONTEXT_ONLY|SANDBOX_NO_NEW_PRIVILEGES) remedy='Rerun the same installer from a normal authorized terminal; this process cannot confirm or configure the desktop sandbox.' ;;
      SANDBOX_NOSUID) remedy='Choose a local Linux installation directory on a filesystem that supports the sandbox helper, then rerun the installer.' ;;
      *) remedy='Resolve the reported dependency or sandbox condition and rerun the same installer.' ;;
    esac
    fail "$sandbox_code: $remedy Details: $doctor_log"
  fi
  fi
fi
if [ "$with_mujoco" = true ]; then
  stage=physics
  physics_log="$product/.install/physics-check.log"
  if "$product/lyapunov" physics-check --managed-sdk > "$physics_log" 2>&1; then
    log "PASS: native MuJoCo physics. Details: $physics_log"
  else
    physics_exit=$?
    printf '%s\n' "Native MuJoCo physics check failed (exit $physics_exit); the previous version remains current. Details: $physics_log" >&2
    exit "$physics_exit"
  fi
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
desktop_entry="$data_home/applications/lyapunov-desktop.desktop"
entry_transaction="$product/.install/legacy-desktop-pending"
export LYAPUNOV_ENTRY_MARKER=$("$product/runtime/node/bin/node" -e 'console.log("X-Lyapunov-Install-Root="+process.argv[1].replaceAll("\\","\\\\"))' "$prefix")
if "$product/runtime/node/bin/node" --input-type=module -e '
  import fs from "node:fs";import p from "node:path";import {pathToFileURL} from "node:url";
  const [root,bin,data,desktop,product]=process.argv.slice(1),entry=p.join(data,"applications/lyapunov-desktop.desktop"),pending=entry+".lyapunov-upgrade-pending",transaction=p.join(product,".install/legacy-desktop-pending");
  const marker=process.env.LYAPUNOV_ENTRY_MARKER,launcher=p.join(bin,"lyapunov"),launcherMarker="# Lyapunov managed launcher root: "+root;
  const present=file=>{try{return fs.lstatSync(file)}catch(e){if(e.code==="ENOENT")return null;throw e}};
  const read=file=>fs.readFileSync(file,"utf8"),regular=file=>present(file)?.isFile()===true;
  // Foreign launchers are checked before any legacy desktop transaction.
  if(present(launcher)&&(!regular(launcher)||!read(launcher).split("\n").includes(launcherMarker))){console.error("Refusing to replace an unmanaged entry: "+launcher);process.exit(2)}
  const decode=value=>value.replace(/\\([\\snrt])/g,(_,c)=>({"\\":"\\",s:" ",n:"\n",r:"\r",t:"\t"}[c]));
  const fields=text=>{let active=false;const out={};for(const line of text.split(/\r?\n/)){if(line.startsWith("[")){active=line==="[Desktop Entry]";continue}const match=active&&/^([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(line);if(match){if(match[1] in out)throw Error("Duplicate desktop identity field");out[match[1]]=decode(match[2])}}return out};
  const sameProduct=text=>{
    try{
      const row=fields(text);if(row.Type!=="Application"||!/^Lyapunov(?:\s|[\u3400-\u9fff]|$)/.test(row.Name??"")||row.StartupWMClass!=="lyapunov-desktop")return false;
      const suffix=p.join("packages","desktop","icons","lyapunov.png");if(!p.isAbsolute(row.Icon??"")||!row.Icon.endsWith("/"+suffix))return false;
      const alias=row.Icon.slice(0,-suffix.length-1),old=fs.realpathSync(alias),release=JSON.parse(read(p.join(old,"RELEASE.json"))),pkg=JSON.parse(read(p.join(old,"package.json")));
      if(release.product!=="LyapunovDSH"||release.platform!=="linux-x64"||typeof release.version!=="string"||pkg.name!=="lyapunov-dsh"||!regular(row.Icon))return false;
      const exec=(row.Exec??"").trim(),quoted=exec.startsWith("\""),match=quoted?/^"((?:\\.|[^"\\])*)"(?:\s|$)/.exec(exec):/^(\S+)/.exec(exec);if(!match)return false;
      const executable=fs.realpathSync(match[1].replace(/\\([\\"`$])/g,"$1")),direct=fs.realpathSync(p.join(old,"lyapunov"));
      if(executable===direct)return true;
      if(!regular(executable)||present(executable).size>65536)return false;
      const body=read(executable);if(!/\bexec\s+\.\/lyapunov\s+desktop\b/.test(body))return false;
      for(const assignment of body.matchAll(/(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)=(["\x27])([^"\x27\n]+)\2/g)){
        try{if(fs.realpathSync(assignment[3])===old&&body.includes("cd \"$"+assignment[1]+"\""))return true}catch{}
      }
    }catch{}return false;
  };
  let migrated=false;
  if(desktop==="true"&&present(entry)&&(!regular(entry)||!read(entry).split("\n").includes(marker))){
    if(!regular(entry)||!sameProduct(read(entry)))throw Error("Refusing to replace an unmanaged entry: "+entry);
    if(present(pending))throw Error("Previous desktop upgrade is pending: "+pending);
    const original=fs.readFileSync(entry),legacy=p.join(p.dirname(entry),"lyapunov-desktop.legacy.desktop");
    if(present(legacy)&&(!regular(legacy)||!fs.readFileSync(legacy).equals(original)))throw Error("Refusing to replace a different legacy desktop entry: "+legacy);
    const backup=p.join(root,"entry-backups","lyapunov-desktop.original");fs.mkdirSync(p.dirname(backup),{recursive:true,mode:0o700});
    if(present(backup)){if(!regular(backup)||!fs.readFileSync(backup).equals(original))throw Error("Legacy desktop backup conflict: "+backup)}else fs.writeFileSync(backup,original,{flag:"wx",mode:0o600});
    if(!present(legacy))fs.writeFileSync(legacy,original,{flag:"wx",mode:0o644});
    fs.renameSync(entry,pending);migrated=true;fs.writeFileSync(transaction,pending,{flag:"wx",mode:0o600});
    console.log("Previous Lyapunov entry retained at "+legacy+"; exact backup: "+backup);
  }
  const {installEntries}=await import(pathToFileURL(p.join(product,"distribution/linux/install-entry.mjs")).href);
  try{console.log(JSON.stringify(installEntries(root,bin,data,desktop==="true")))}catch(error){
    if(migrated){if(present(entry)&&!read(entry).split("\n").includes(marker))throw Error("Original entry preserved at "+pending+"; destination changed");fs.renameSync(pending,entry);fs.unlinkSync(transaction)}throw error;
  }
' "$prefix" "$bin_dir" "$data_home" "$with_desktop" "$product"; then :; else
  entry_exit=$?
  printf '%s\n' 'Could not prepare the per-user launcher or desktop entry; the previous entry is preserved.' >&2
  exit "$entry_exit"
fi
stage=activate
if [ -n "$previous" ] && [ "$previous" != "versions/$release_id" ]; then
  link_pending="$prefix/.previous.$$"; ln -s -- "$previous" "$link_pending"; mv -Tf -- "$link_pending" "$prefix/previous"; link_pending=
fi
link_pending="$prefix/.current.$$"; ln -s -- "versions/$release_id" "$link_pending"; mv -Tf -- "$link_pending" "$prefix/current"; link_pending=
stage=complete
if [ "$with_mujoco" = true ]; then log "READY: $release_id; managed MuJoCo doctor and native physics passed."; else log "INSTALLED_WITHOUT_MUJOCO: $release_id (explicit --without-mujoco)."; fi
log "Start with: $bin_dir/lyapunov"
if [ -n "$previous" ] && [ "$previous" != "versions/$release_id" ]; then log "Previous version retained at $prefix/$previous; rollback link: $prefix/previous"; fi
