# Bishop Estates keyfob panels: what's there and how to reach them

Not served by the website (`.vercelignore` excludes `docs/`). It describes
the club's access system, so keep it out of public folders.

## The hardware

Two 4-door access controllers, UHPPOTE-compatible (the Windows "Apartment
Management System" v8.83 manages them today). They talk a simple protocol:
64-byte UDP packets on port 60000, first byte 0x17 (0x19 on newer firmware),
second byte the command.

| Controller (serial) | Where | Address (10.1.10.x LAN) | MAC | Firmware | Door 1 | Door 2 | Door 3 | Door 4 |
|---|---|---|---|---|---|---|---|---|
| 423141044 | snack shack | 10.1.10.153 | 00:66:19:38:9e:b4 | v6.62 (2015-12-15) | Main Gate | Snack | (unused) | (unused) |
| 423150481 | pump room | 10.1.10.173 | 00:66:19:38:c3:91 | v6.62 (2015-12-15) | Pump Room | Swim Shack | Mens | Womens |

Doug, 2026-10-12: the Mens and Womens doors are on the controller but not
wired to a lock yet.

Each controller keeps its own copy of the keyfob list (both held the same 135
on 2026-10-12). Every keyfob has a valid-from and valid-until date and, per
door, allowed or not. A blank 125 kHz fob prints its number two ways: 10
digits (0000786777) and facility,card (012,00345); the panel stores
facility x 65536 + card. `_shared/keyfobs.ts` `parseFobNumber` accepts both.

The phone "Unlock" today (gate bridge, `bridge/gate_bridge.py`) logs in to
the web page built into the snack shack controller (10.1.10.153, panel type
`mengqi_hxc7000` in `gate_panels`) and presses "Remote Open #1", so it can
only open the Main Gate.

## How we reach them

The club PC on the 10.1.10.x network (the same PC that runs the gate bridge
service, PoolsideGateBridge). Doug reaches it with TeamViewer or AnyDesk.
Python for both the bridge and the panel tools is the bridge's own:
`C:\PoolsideGateBridge\venv\Scripts\python.exe`.

## The library: uhppoted

`uhppoted` (Python) speaks this protocol: find controllers, count cards, read
a card by position, add or change a card (`put_card`), delete a card, open a
door (`open_door`). The GitHub organization (github.com/uhppoted) disappeared
on 2026-09-15; PyPI still has it. A copy of 0.9.0 and 0.9.1.1 (wheels, source
and METADATA) is saved on Doug's Mac at `poolside-app/vendor/uhppoted/`
(outside this repo). 0.9.1 and later need Python 3.10+; 0.9.0 runs on 3.9.

If it ever vanished from PyPI too: install from that saved wheel (`pip
install path\to\uhppoted-0.9.1.1-py3-none-any.whl`). The protocol is small
enough to write directly if we had to, but there's no need while the library
works.

Installed on the club PC 2026-10-12:

    C:\PoolsideGateBridge\venv\Scripts\python.exe -m pip install uhppoted

## Reading them (read-only, nothing changes)

`bridge/panel_check_readonly.py` can only send the three reads (find
controllers 0x94, count cards 0x58, read a card 0x5C). It refuses anything
else at the socket, replaces every library method that writes, and calls
nothing else. `python3 scripts/test_panel_export.py` checks the guard.

Get it onto the club PC (PowerShell):

    [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest https://www.poolsideapp.com/bridge/panel_check_readonly.py -UseBasicParsing -OutFile C:\PoolsideGateBridge\panel_check_readonly.py

Summary (counts only, no numbers):

    C:\PoolsideGateBridge\venv\Scripts\python.exe C:\PoolsideGateBridge\panel_check_readonly.py

Every keyfob to a CSV on that PC (full numbers, dates, doors; no PINs):

    C:\PoolsideGateBridge\venv\Scripts\python.exe C:\PoolsideGateBridge\panel_check_readonly.py --export

If nothing answers, add `--broadcast 10.1.10.255:60000`. If Windows asks
whether Python may use the network, allow it.

## What the first reads found (2026-10-12)

135 keyfobs, identical on both controllers.
- 82 member keyfobs (Main Gate and restrooms) expire at the end of the season
  (Oct 30/31; one Dec 31).
- 40 open every door and never expire (board, staff, lifeguards: to check).
- 12 member keyfobs never expire, all added in 2026 (9 on April 11): set to
  2099 instead of the season end, so they keep working unpaid.
The panels hold numbers, not names; the Windows program's card list (export
to Excel) has the names.

## Rules for later (PLAN.md P5)

- Writing to the panels (adding, changing, turning off keyfobs, opening
  doors) goes through the gate bridge, behind Doug's "Auto keyfob
  activations" switch, after the audit.
- Once Poolside manages the keyfob list, stop uploading from the Windows
  program: its copy would overwrite the panels.
- Members never get the Pump Room.
