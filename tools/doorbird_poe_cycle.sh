#!/bin/bash
# Cold-boot the DoorBird by cutting PoE on the switch port it sits on, then restoring it.
#
# The DoorBird (192.168.0.83, MAC 1c:ca:e3:7c:31:5f) is on Tw1/0/1 of the SG3218XP-M2
# (192.168.0.2), PoE class 3, ~2.5 W. No PoE schedule or time-range is configured on any
# port, so the switch is NOT what restarts the device at ~1 am each night.
#
# Credentials come from /projects/unraid-ops/.env (SWITCH_HOST/SWITCH_USER/SWITCH_PASS) —
# switch access belongs to the unraid-ops project; this script only borrows it.
# Nothing is written to startup-config, so a switch reboot restores the port to enabled.
#
# Usage: doorbird_poe_cycle.sh [off-seconds, default 15]
set -u
OFF_SECONDS="${1:-15}"
DRY_RUN="${DRY_RUN:-0}"          # 1 = run the same CLI path but never actually cut power
set -a; . /projects/unraid-ops/.env; set +a
# NB: .env defines PORT for something else, so the switch port has its own name and is
# read AFTER the .env is sourced. Getting this wrong silently pointed the CLI at "8765".
SW_PORT="${SW_PORT:-two-gigabitEthernet 1/0/1}"
SSHOPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 \
 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
 -o KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1 -o Ciphers=+aes128-cbc,3des-cbc"

# The JetStream CLI needs a pty and carriage returns, and pages long output on space.
run_cli() {
  {
    sleep 3
    for c in "$@"; do printf '%s\r' "$c"; sleep 2; printf ' '; sleep 1; done
    sleep 2; printf 'logout\r'; sleep 2
  } | timeout 180 sshpass -p "$SWITCH_PASS" ssh -tt $SSHOPTS "$SWITCH_USER@$SWITCH_HOST" 2>&1 \
    | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g'
}

FIRST_ACTION='power inline supply disable'
[ "$DRY_RUN" = "1" ] && FIRST_ACTION='power inline supply enable'
echo "== PoE off on $SW_PORT for ${OFF_SECONDS}s (dry_run=$DRY_RUN)"
run_cli 'enable' 'configure' "interface $SW_PORT" "$FIRST_ACTION" 'end' | tail -8
sleep "$OFF_SECONDS"
echo "== PoE back on"
run_cli 'enable' 'configure' "interface $SW_PORT" 'power inline supply enable' 'end' | tail -6
sleep 3
echo "== port state"
run_cli 'enable' 'show power inline information interface' | grep -E "Tw1/0/1|Power-Status"
