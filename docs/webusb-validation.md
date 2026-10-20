# WebUSB update validation

The updater implements Link65 DfuSe over WebUSB. It does not call a native
helper. The bundled target is the unchanged firmware v1.0.2-rc1 from the firmware
repository. This web application change does not change keyboard firmware.

## Automated checks

- Existing settings, backup, reset and key tester checks remain enabled.
- Approved binary SHA-256, DFU suffix CRC, payload size and vector validation.
- Expected VID/PID, DFU interface, memory layout, transfer size and DFU version.
- Two complete reads each of application 36KiB and settings 4KiB.
- Probe audit requires zero erase pages, firmware bytes and leave commands.
- Interrupted, short, changing and concurrent reads fail closed.
- Persistent configuration and Flash backups survive reload and JSON import.
- No firmware write without current probe, durable matching backups and consent.
- Known source application fingerprints bind the probe to Link65 firmware.
- Simulated writes preserve bootloader and settings, then verify payload readback.
- Readback failure keeps DFU and blocks normal-mode execution.
- Normal reconnect compares all settings and restores only on explicit action.
- Actual UI controller tests prove file loading, backups, probes, cancelling and
  revoking final consent never cause a firmware write.

The existing compiled Cortex-M3 firmware integration checks are also run through
the firmware repository emulator. They are separate from real USB checks.

## Physical validation boundary

The Windows Edge WebUSB device picker, interface claim and actual Flash reads
require the physical keyboard and browser permission. Native HIDAPI or dfu-util
results do not count as browser WebUSB validation. Record physical results
separately, excluding user keymaps, Flash dumps and unique device identifiers
from Git. Never count a USB disconnect alone as a successful update.

No physical erase or firmware download is needed to verify connection and read
compatibility. Physical firmware recording remains a separate, explicit action.
