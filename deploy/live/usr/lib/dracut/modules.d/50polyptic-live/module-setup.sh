#!/bin/bash
# Polyptic's dracut module (POL-35). Pulled in by `dracut --add polyptic-live` when
# deploy/build-live-image.sh builds the initramfs inside the image chroot.
#
# It exists for one reason: dracut's livenet downloads the WHOLE rootfs.squashfs into the initramfs
# root before dmsquash-live can loop-mount it, and the kernel caps that tmpfs at 50% of RAM. Same
# ceiling casper's `iso-url=` hit on real hardware (POL-46), same fix — raise the cap, and when the
# box genuinely cannot hold the image, say so in words instead of dying inside a shell.
#
# `check()` returns 0 unconditionally: the module is never auto-detected, only `--add`ed.

check() {
    return 0
}

depends() {
    echo "dmsquash-live livenet"
    return 0
}

install() {
    # `cmdline` is the earliest hook that runs with a writable / and a parsed cmdline, and it is well
    # before the initqueue where livenet's download happens.
    inst_hook cmdline 00 "$moddir/polyptic-ram.sh"
    inst_multiple awk mount sleep
}
