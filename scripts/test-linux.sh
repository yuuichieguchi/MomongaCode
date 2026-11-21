set -eu
apt-get update -qq
if [ "${WITHOUT_SYSTEM_RIPGREP:-}" = 1 ]; then SYSTEM_RIPGREP=; else SYSTEM_RIPGREP=ripgrep; fi
apt-get install -y -qq bubblewrap git lsof procps $SYSTEM_RIPGREP tini openssh-client openjdk-17-jre-headless > /dev/null
apt-get install -y -qq build-essential libcurl4-openssl-dev libssl-dev zlib1g-dev libexpat1-dev xz-utils > /dev/null
mkdir /opt/git-build
curl -fsSL https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz | tar -xJ -C /opt/git-build --strip-components=1
make -C /opt/git-build -j"$(nproc)" prefix=/usr NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 all install > /opt/git-build.log 2>&1
git --version
useradd -m dev
if [ -n "${MOMONGA_INJECT_SMALL_FS:-}" ]; then
  if [ "$(stat -c %u "$MOMONGA_INJECT_SMALL_FS")" != "$(id -u dev)" ]; then echo "SETUP_FAILED MOMONGA_INJECT_SMALL_FS=$MOMONGA_INJECT_SMALL_FS is owned by uid $(stat -c %u "$MOMONGA_INJECT_SMALL_FS"), not by dev (uid $(id -u dev)): give the tmpfs uid=$(id -u dev),gid=$(id -g dev)"; exit 1; fi
fi
mkdir /home/dev/src
tar --warning=no-unknown-keyword -xf - -C /home/dev/src
chown -R dev:dev /home/dev/src
node --version
bwrap --version
su dev -c 'cd /home/dev/src && npm ci --no-audit --no-fund > /home/dev/npm-ci.log 2>&1 && tail -3 /home/dev/npm-ci.log'
su dev -c 'cd /home/dev/src && npm ci --no-audit --no-fund --prefix compliance/open-responses > /home/dev/compliance-ci.log 2>&1 && tail -3 /home/dev/compliance-ci.log'
tini -s -- su dev -c "cd /home/dev/src && $* ; status=\$? ; if [ -n \"\${MOMONGA_INJECTION_REPORT:-}\" ]; then if [ -f \"\$MOMONGA_INJECTION_REPORT\" ]; then echo INJECTION_REPORT_BEGIN; cat \"\$MOMONGA_INJECTION_REPORT\"; echo INJECTION_REPORT_END; else echo \"INJECTION_REPORT_MISSING \$MOMONGA_INJECTION_REPORT\"; status=1; fi; fi; echo EXIT=\$status"
