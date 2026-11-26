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
CG=/sys/fs/cgroup
US=$CG/user.slice
U1=$US/user-1000.slice
USVC=$U1/user@1000.service
export PATH=/usr/sbin:/sbin:$PATH
export XDG_RUNTIME_DIR=$XDG
export DBUS_SESSION_BUS_ADDRESS=$BUS
unset DOCKER_CONTEXT
export DOCKER_HOST=unix://$XDG/docker.sock

enable() {
  echo '+cpu +memory +pids' | sudo tee "$1" >/dev/null
}

enable "$CG/cgroup.subtree_control"
enable "$US/cgroup.subtree_control"
sudo mkdir -p "$USVC"
enable "$U1/cgroup.subtree_control"
sudo chown -R box:box "$U1"

mkdir -p -m 700 "$XDG" || fail "cannot create $XDG"
[[ -d $XDG && ! -L $XDG && $(stat -c '%U:%a' "$XDG") == box:700 ]] ||
  fail "$XDG must be a directory owned by box with mode 700"

pat_dbus="unix:path=$XDG/bus"
if ! pgrep -u box -f "$pat_dbus" >/dev/null
then
  rm -f "$XDG/bus"
  dbus-daemon --session --address="$BUS" --fork
fi

pat_sd='/usr/lib/systemd/systemd --user'
if ! pgrep -u box -f "$pat_sd" >/dev/null
then
  find "$USVC" -mindepth 1 -depth -type d \
    -exec rmdir {} + 2>/dev/null || true
  echo '-cpu -memory -pids' \
    >"$USVC/cgroup.subtree_control" || true
  inner='#!/bin/sh
set -eu
mount -t tmpfs -o mode=755,size=32M tmpfs /run
mkdir -p /run/systemd/system
p=/sys/fs/cgroup/user.slice
p=$p/user-1000.slice/user@1000.service
echo $$ >"$p/cgroup.procs"
exec setpriv --reuid=1000 --regid=1000 \
  --init-groups --inh-caps=-all env -i \
  PATH=/usr/sbin:/sbin:/usr/bin:/bin \
  HOME=/home/box USER=box LOGNAME=box \
  XDG_RUNTIME_DIR=/tmp/xdg-box \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/xdg-box/bus \
  /usr/lib/systemd/systemd --user'
  rm -f "$XDG/systemd/private" "$XDG/systemd/notify"
  log=$XDG/systemd-user.log
  sudo -n unshare --mount --propagation \
    private setsid sh -c "$inner" sh >"$log" 2>&1 \
    </dev/null &
fi

ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
do
  if systemctl --user show-environment \
    >/dev/null 2>&1
  then
    ok=1
    break
  fi
  sleep 1
done
[ "$ok" = 1 ] || fail "user manager timed out; see $XDG/systemd-user.log"

systemctl --user cat docker >/dev/null 2>&1 ||
  fail 'docker unit missing; run dockerd-rootless-setuptool.sh install'
systemctl --user start docker || fail 'docker user service failed to start'

info=$(docker info 2>&1) || fail 'docker info failed'
grep -q 'Cgroup Driver: systemd' <<<"$info" || fail 'expected systemd cgroup driver'
grep -Eqi '^[[:space:]]*rootless[[:space:]]*$' <<<"$info" ||
  fail 'docker info did not report rootless mode'
for sock in /var/run/docker.sock /run/docker.sock
do
  [[ ! -e $sock && ! -L $sock ]] || fail "rootful socket path exists: $sock"
done
for name in dockerd containerd
do
  if pgrep -u 0 -x "$name" >/dev/null
  then
    fail "root $name is running"
  else
    [[ $? == 1 ]] || fail "cannot check for root $name"
  fi
done
docker version --format '{{.Server.Version}}' || fail 'docker version failed'
docker info --format '{{.ID}}' || fail 'docker daemon ID check failed'
echo 'ok: rootless docker, cgroup driver systemd'
