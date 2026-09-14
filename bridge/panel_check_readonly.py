"""
panel_check_readonly.py — look at Bishop's keyfob panels without changing anything.

Finds the access controllers on the local network, then reads how many cards
each one holds and summarizes them: how many never expire, how many open each
door. It cannot add, change, disable or delete a card, open a door, or change
any setting. That is enforced three separate ways, below, not just promised.

Run it on a Windows PC at the pool, on the same network as the panels:

    py -m pip install uhppoted
    py panel_check_readonly.py

Optional:
    --broadcast 10.1.10.255:60000   if the default broadcast finds nothing
    --show-cards                    list each card (card number shortened to its last 3 digits)
"""

import argparse
import datetime
import socket
import sys

# ─────────────────────────────────────────────────────────────────────────────
# READ-ONLY GUARD
#
# The panels speak a simple protocol: every request is a 64-byte packet whose
# first byte is 0x17 and whose SECOND byte says what to do. Reads and writes
# are just different values of that byte — 0x58 "how many cards", 0x50 "add
# or change a card", 0x52 "delete a card", 0x40 "open a door", and so on.
#
# So the guard sits at the very last moment before a packet leaves this
# computer, looks at that byte, and refuses to transmit anything that is not
# one of the three reads this script needs. It is an ALLOW list, not a block
# list: a code nobody thought of is refused, not waved through. If it refuses,
# the packet is never sent — the panel never sees it.
# ─────────────────────────────────────────────────────────────────────────────

START_OF_MESSAGE = {0x17, 0x19}          # 0x19 is the same protocol on newer firmware

ALLOWED_READS = {
    0x94: "find controllers",
    0x58: "count cards",
    0x5C: "read one card by position",
}


class WriteBlocked(RuntimeError):
    pass


def check_packet(data) -> None:
    """Raise WriteBlocked unless `data` is a read this script is allowed to send."""
    b = bytes(data)
    if len(b) != 64:
        raise WriteBlocked(f"refused: packet is {len(b)} bytes, expected 64")
    if b[0] not in START_OF_MESSAGE:
        raise WriteBlocked(f"refused: unrecognized packet start 0x{b[0]:02X}")
    if b[1] not in ALLOWED_READS:
        raise WriteBlocked(f"refused: 0x{b[1]:02X} is not a read — nothing was sent")


class ReadOnlySocket(socket.socket):
    """A socket that checks every outgoing packet, and will not open TCP at all."""

    def sendto(self, data, *args):
        check_packet(data)
        return super().sendto(data, *args)

    def send(self, data, *args):
        check_packet(data)
        return super().send(data, *args)

    def sendall(self, data, *args):
        check_packet(data)
        return super().sendall(data, *args)

    def connect(self, *args):
        # The library can talk TCP to a controller at a known address. This
        # script never needs to, so the door is simply shut.
        raise WriteBlocked("refused: this script does not open TCP connections")


# Layer 1: every socket created from here on is the guarded one — including the
# ones the library creates inside its own code.
socket.socket = ReadOnlySocket

from uhppoted.uhppote import Uhppote  # noqa: E402  (must come after the guard is installed)

# Layer 2: every method on the library that can change something is replaced
# with one that refuses before it builds a packet. The socket guard would stop
# these anyway; this makes the refusal happen earlier and say what was tried.
WRITE_METHODS = [
    "set_ip", "set_time", "set_listener", "set_door_control", "open_door",
    "put_card", "put_card_record", "delete_card", "delete_all_cards",
    "set_event_index", "record_special_events", "set_time_profile",
    "set_time_profile_record", "delete_all_time_profiles", "add_task",
    "add_task_record", "refresh_tasklist", "clear_tasklist", "set_pc_control",
    "set_interlock", "activate_keypads", "set_door_passcodes",
    "set_door_passcodes_record", "set_antipassback", "restore_default_parameters",
]


def _blocked(name):
    def refuse(*_a, **_k):
        raise WriteBlocked(f"refused: {name}() changes the panel — this script is read-only")
    return refuse


def read_only_client(broadcast: str) -> Uhppote:
    client = Uhppote(bind="0.0.0.0", broadcast=broadcast, listen="0.0.0.0:60001")
    for name in WRITE_METHODS:
        if hasattr(client, name):
            setattr(client, name, _blocked(name))
    return client


# Layer 3 is simply that nothing below calls anything except the three reads.

# ─────────────────────────────────────────────────────────────────────────────

# What each door number means at Bishop, from the Controllers screen in the
# Windows program. Anything not listed is shown as "door N".
DOOR_NAMES = {
    423141044: {1: "Main Gate", 2: "Snack", 3: "(unused)", 4: "(unused)"},
    423150481: {1: "Pump Room", 2: "Swim Shack", 3: "Mens", 4: "Womens"},
}

NEVER_EXPIRES_AFTER = datetime.date(2090, 1, 1)


def door_label(serial, door):
    return DOOR_NAMES.get(serial, {}).get(door, f"door {door}")


def summarize(client, serial, show_cards):
    count = client.get_cards(serial)
    total = int(getattr(count, "cards", 0) or 0)
    print(f"  cards stored:  {total}")
    if total == 0:
        return

    today = datetime.date.today()
    active = expired = never = 0
    by_door = {1: 0, 2: 0, 3: 0, 4: 0}
    rows = []

    for index in range(1, total + 1):
        rec = client.get_card_by_index(serial, index)
        if rec is None:
            continue
        number = int(getattr(rec, "card_number", 0) or 0)
        # 0 = empty slot, 0xFFFFFFFF = a card that was deleted but not yet compacted
        if number in (0, 0xFFFFFFFF):
            continue
        end = getattr(rec, "end_date", None)
        if end and end < today:
            expired += 1
        else:
            active += 1
            if end and end >= NEVER_EXPIRES_AFTER:
                never += 1
            for d in (1, 2, 3, 4):
                if int(getattr(rec, f"door_{d}", 0) or 0) != 0:
                    by_door[d] += 1
        rows.append((number, getattr(rec, "start_date", None), end,
                     [int(getattr(rec, f"door_{d}", 0) or 0) for d in (1, 2, 3, 4)]))

    print(f"  still valid:   {active}")
    print(f"  expired:       {expired}")
    print(f"  never expire:  {never}   (valid-until date after 2090)")
    print("  valid cards that open each door:")
    for d in (1, 2, 3, 4):
        print(f"    {door_label(serial, d):<12} {by_door[d]}")

    if show_cards:
        print("  cards:")
        for number, start, end, doors in rows:
            opens = ", ".join(door_label(serial, d + 1) for d, v in enumerate(doors) if v) or "no doors"
            print(f"    ...{str(number)[-3:]}   {start} -> {end}   {opens}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Read-only look at the keyfob panels.")
    ap.add_argument("--broadcast", default="255.255.255.255:60000")
    ap.add_argument("--show-cards", action="store_true")
    args = ap.parse_args(argv)

    print("Read-only mode. This script cannot change a card, a door or a setting.\n")
    client = read_only_client(args.broadcast)

    found = client.get_all_controllers()
    if not found:
        print("No controllers answered.")
        print("Check this PC is on the pool network, then try: --broadcast 10.1.10.255:60000")
        return 1

    for c in found:
        serial = int(c.controller)
        print(f"Controller {serial}")
        print(f"  address:       {c.ip_address}   mask {c.subnet_mask}   gateway {c.gateway}")
        print(f"  MAC / firmware: {c.mac_address}   {c.version} ({c.date})")
        try:
            summarize(client, serial, args.show_cards)
        except WriteBlocked as e:        # should never happen — reads only above
            print(f"  STOPPED: {e}")
        except Exception as e:           # a slow panel should not look like a crash
            print(f"  could not read cards: {e}")
        print()

    print("Done. Nothing was changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
