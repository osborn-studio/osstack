#!/bin/bash
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

[[ $(id -u) == 1000 && $(id -un) == box ]] ||
  fail 'run as box (uid 1000)'

XDG=/tmp/xdg-box
BUS=unix:path=$XDG/bus
export PATH=/usr/sbin:/sbin:$PATH
export XDG_RUNTIME_DIR=$XDG
export DBUS_SESSION_BUS_ADDRESS=$BUS

names=(systemd rootlesskit dockerd containerd dbus-daemon)
# Collect matching PIDs and their names for the caller.
collect() {
  local name pid candidates
  pids=()
  survivors=()
  for name in "$@"
  do
    candidates=$(pgrep -u box -x "$name") ||
      [[ $? == 1 ]] || fail "cannot check for $name"
    for pid in $candidates
    do
      case "$name" in
        systemd)
          grep -zFxq -- '--user' "/proc/$pid/cmdline" 2>/dev/null || continue ;;
        dbus-daemon)
          grep -zFxq -- "--address=$BUS" "/proc/$pid/cmdline" 2>/dev/null ||
            continue ;;
        *)
          grep -Eq '/user-1000\.slice(/|$)' "/proc/$pid/cgroup" 2>/dev/null ||
            continue ;;
      esac
      pids+=("$pid")
      survivors+=("$name($pid)")
    done
  done
}

if systemctl --user is-active docker >/dev/null 2>&1
then
  systemctl --user stop docker
fi

collect systemd
if (( ${#pids[@]} ))
then
  systemctl --user exit >/dev/null 2>&1 || true
  for ((i=0; i<10; i++))
  do
    collect systemd
    (( ${#pids[@]} )) || break
    sleep 1
  done
fi

collect "${names[@]}"
if (( ${#pids[@]} ))
then
  kill -TERM "${pids[@]}" 2>/dev/null || true
  for ((i=0; i<5; i++))
  do
    sleep 1
    collect "${names[@]}"
    (( ${#pids[@]} )) || break
  done
fi
if (( ${#pids[@]} ))
then
  kill -KILL "${pids[@]}" 2>/dev/null || true
  sleep 1
fi
collect "${names[@]}"
(( ${#pids[@]} == 0 )) || fail "still running: ${survivors[*]}"
echo 'ok: stopped rootless docker session'
