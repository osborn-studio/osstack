#!/bin/bash
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

[[ $(id -u) == 1000 && $(id -un) == box ]] ||
  fail 'run as box (uid 1000)'

unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///tmp/xdg-box/docker.sock

# Docker validates the repository name and optional tag at local inspection.
ref='^([[:alnum:]]|\[)[][[:alnum:]._:/-]*@sha256:[[:xdigit:]]{64}$'
[[ $# == 1 && $1 =~ $ref ]] ||
  fail 'supply one image pinned by digest: name@sha256:<64 hex>'
image=$1
docker image inspect "$image" >/dev/null 2>&1 ||
  fail "local image check failed; pull by digest with: docker pull $image"

disk=$(df --output=iavail,avail -B1 -- "$HOME" 2>/dev/null) ||
  fail 'cannot read free inodes and bytes for HOME'
read -r inodes bytes <<<"${disk##*$'\n'}"
[[ $inodes =~ ^[0-9]+$ && $bytes =~ ^[0-9]+$ ]] ||
  fail 'invalid free inode or byte count for HOME'
(( inodes >= 100000 )) || fail 'HOME has fewer than 100000 free inodes'
(( bytes >= 5 * 1024**3 )) || fail 'HOME has less than 5 GiB free'

flags=(--pull=never --network none --memory 128m --pids-limit 64 --cpus 1)
limits=$(docker run --rm "${flags[@]}" "$image" sh -c '
  cd /sys/fs/cgroup && cat memory.max pids.max cpu.max' 2>/dev/null) ||
  fail 'cannot read container cgroup limits'
[[ $limits == $'134217728\n64\n100000 100000' ]] ||
  fail 'unexpected memory.max, pids.max or cpu.max'
net=$(docker run --rm "${flags[@]}" "$image" sh -c 'ls /sys/class/net' 2>/dev/null) ||
  fail 'cannot read container network interfaces'
[[ $net == lo ]] || fail 'expected only the loopback interface'

cid=
cleanup() {
  if [[ -n $cid ]]
  then
    docker rm -f "$cid" >/dev/null 2>&1 || fail 'OOM container cleanup failed'
  fi
}
trap cleanup EXIT
trap 'fail "OOM check interrupted"' HUP INT TERM
cid=$(docker create --name "osstack-limits-oom-$$" "${flags[@]}" "$image" \
  tail /dev/zero 2>/dev/null) ||
  fail 'OOM container creation failed'
docker start "$cid" >/dev/null 2>&1 || fail 'OOM container start failed'
code=$(timeout 60s docker wait "$cid" 2>/dev/null) ||
  fail 'OOM container wait failed or exceeded 60 s'
oom=$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null) ||
  fail 'OOM state inspection failed'
[[ $oom == true && $code == 137 ]] ||
  fail "expected OOMKilled=true and exit 137; got $oom and $code"
cleanup
trap - EXIT HUP INT TERM
echo 'ok: memory.max=134217728 pids.max=64 cpu.max="100000 100000"'
