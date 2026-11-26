#!/bin/bash
set -euo pipefail

XDG=/tmp/xdg-box
BUS=unix:path=$XDG/bus
export PATH=/usr/sbin:/sbin:$PATH
export XDG_RUNTIME_DIR=$XDG
export DBUS_SESSION_BUS_ADDRESS=$BUS

pat_sd='/usr/lib/systemd/systemd --user'
pat_dbus="unix:path=$XDG/bus"
pat_rk='/tmp/xdg-box/dockerd-rootless'
pat_ct='/tmp/xdg-box/docker/containerd'

stop_pat() {
  local pat=$1
  local sig=${2:-TERM}
  local pids
  pids=$(pgrep -u box -f "$pat" || true)
  if [ -n "${pids:-}" ]
  then
    kill -s "$sig" $pids || true
  fi
}

if systemctl --user is-active docker \
  >/dev/null 2>&1
then
  systemctl --user stop docker
fi

if pgrep -u box -f "$pat_sd" >/dev/null
then
  systemctl --user exit >/dev/null 2>&1 \
    || true
fi

i=0
while [ "$i" -lt 10 ]
do
  if ! pgrep -u box -f "$pat_sd" >/dev/null
  then
    break
  fi
  sleep 1
  i=$((i + 1))
done

stop_pat "$pat_sd"
stop_pat "$pat_rk"
stop_pat "$pat_ct"
stop_pat "$pat_dbus"

for pid in $(pgrep -u box -x dockerd || true)
do
  cg=$(cat /proc/$pid/cgroup 2>/dev/null \
    || true)
  case "$cg" in
    *user-1000.slice*) kill "$pid" || true ;;
  esac
done

i=0
while [ "$i" -lt 5 ]
do
  alive=0
  if pgrep -u box -f "$pat_sd" >/dev/null
  then
    alive=1
  fi
  if pgrep -u box -f "$pat_dbus" >/dev/null
  then
    alive=1
  fi
  if pgrep -u box -f "$pat_rk" >/dev/null
  then
    alive=1
  fi
  if [ "$alive" = 0 ]
  then
    break
  fi
  sleep 1
  i=$((i + 1))
done

if pgrep -u box -f "$pat_sd" >/dev/null \
  || pgrep -u box -f "$pat_dbus" >/dev/null \
  || pgrep -u box -f "$pat_rk" >/dev/null
then
  stop_pat "$pat_sd" KILL
  stop_pat "$pat_rk" KILL
  stop_pat "$pat_ct" KILL
  stop_pat "$pat_dbus" KILL
fi

echo 'ok: stopped rootless docker session'
